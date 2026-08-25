/**
 * zip.js
 * A minimal, dependency-free ZIP archive writer. Extracted out of
 * utils/xlsx.js in V1.13.2 (an .xlsx file IS a ZIP archive, so xlsx.js
 * already had a complete, working, tested ZIP writer buried inside it —
 * this pulls that exact logic out, unchanged, into its own module so
 * V1.13.2's image/research-bundle ZIP packaging can reuse it verbatim
 * instead of writing a second ZIP implementation). No CDN/remote code —
 * everything here runs from Web APIs (TextEncoder) available in every
 * extension context, popup or background service worker alike.
 *
 * Entries are written STORED (uncompressed), not deflated — the same
 * deliberate choice xlsx.js always made: simpler, 100% dependency-free
 * (no compression algorithm to implement or trust), and for this
 * project's actual payloads (XML text, or already-compressed JPEG/WEBP/
 * PNG images where DEFLATE buys next to nothing anyway) the size cost is
 * a non-issue.
 */
(function (root) {
  'use strict';

  // ---- CRC32 (needed by the ZIP format for each entry) ----
  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  // ---- tiny growable byte buffer ----
  function ByteWriter() {
    this.chunks = [];
    this.length = 0;
  }
  ByteWriter.prototype.pushBytes = function (bytes) {
    this.chunks.push(bytes);
    this.length += bytes.length;
  };
  ByteWriter.prototype.pushU16 = function (v) {
    this.pushBytes(new Uint8Array([v & 0xff, (v >>> 8) & 0xff]));
  };
  ByteWriter.prototype.pushU32 = function (v) {
    this.pushBytes(new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]));
  };
  ByteWriter.prototype.toUint8Array = function () {
    var out = new Uint8Array(this.length);
    var offset = 0;
    for (var i = 0; i < this.chunks.length; i++) {
      out.set(this.chunks[i], offset);
      offset += this.chunks[i].length;
    }
    return out;
  };

  function utf8(str) {
    return new TextEncoder().encode(str);
  }

  function dosDateTime(date) {
    var year = Math.max(1980, date.getFullYear());
    var dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    var dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2));
    return { dosDate: dosDate & 0xffff, dosTime: dosTime & 0xffff };
  }

  /**
   * Builds a ZIP archive (STORED entries only) from a list of
   * { name, data: Uint8Array } file descriptors. `name` may include "/"
   * to place the entry in a subfolder (e.g. "images/0001.jpg") — that's
   * simply part of a ZIP entry's name, no special handling needed.
   */
  function buildZip(files) {
    var when = dosDateTime(new Date());
    var out = new ByteWriter();
    var central = new ByteWriter();
    var offsets = [];

    files.forEach(function (file) {
      var nameBytes = utf8(file.name);
      var data = file.data;
      var crc = crc32(data);
      var localOffset = out.length;
      offsets.push(localOffset);

      // Local file header
      out.pushU32(0x04034b50);
      out.pushU16(20); // version needed
      out.pushU16(0);  // flags
      out.pushU16(0);  // method: stored
      out.pushU16(when.dosTime);
      out.pushU16(when.dosDate);
      out.pushU32(crc);
      out.pushU32(data.length); // compressed size
      out.pushU32(data.length); // uncompressed size
      out.pushU16(nameBytes.length);
      out.pushU16(0); // extra field length
      out.pushBytes(nameBytes);
      out.pushBytes(data);
    });

    files.forEach(function (file, i) {
      var nameBytes = utf8(file.name);
      var data = file.data;
      var crc = crc32(data);

      central.pushU32(0x02014b50);
      central.pushU16(20); // version made by
      central.pushU16(20); // version needed
      central.pushU16(0);  // flags
      central.pushU16(0);  // method: stored
      central.pushU16(when.dosTime);
      central.pushU16(when.dosDate);
      central.pushU32(crc);
      central.pushU32(data.length);
      central.pushU32(data.length);
      central.pushU16(nameBytes.length);
      central.pushU16(0); // extra length
      central.pushU16(0); // comment length
      central.pushU16(0); // disk number start
      central.pushU16(0); // internal attrs
      central.pushU32(0); // external attrs
      central.pushU32(offsets[i]); // local header offset
      central.pushBytes(nameBytes);
    });

    var centralStart = out.length;
    var centralBytes = central.toUint8Array();
    out.pushBytes(centralBytes);

    // End of central directory record
    out.pushU32(0x06054b50);
    out.pushU16(0); // disk number
    out.pushU16(0); // disk with central dir
    out.pushU16(files.length); // entries on this disk
    out.pushU16(files.length); // total entries
    out.pushU32(centralBytes.length);
    out.pushU32(centralStart);
    out.pushU16(0); // comment length

    return out.toUint8Array();
  }

  /**
   * V1.13.2: base64 <-> Uint8Array, chunked to avoid a call-stack overflow
   * from String.fromCharCode.apply(null, hugeArray) on a large image.
   * Used to move raw bytes across chrome.runtime.sendMessage (structured
   * clone support for typed arrays varies enough across contexts that
   * base64-as-a-plain-string is the one encoding guaranteed to survive
   * intact everywhere) and to build the final data: URL
   * chrome.downloads.download() needs (a plain string, never raw bytes).
   */
  function bytesToBase64(bytes) {
    var CHUNK = 8192;
    var binary = '';
    for (var i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  function base64ToBytes(b64) {
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  root.WSZip = {
    buildZip: buildZip,
    bytesToBase64: bytesToBase64,
    base64ToBytes: base64ToBytes,
    crc32: crc32 // exposed for tests; not needed by any real caller
  };
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
