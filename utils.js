"use strict";

/**
 * Normalize Arabic Unicode + lowercase + strip
 * Fixes encoding mismatches between different Arabic keyboards
 */
function norm(text) {
  if (!text) return "";
  // NFC normalization equivalent + lowercase + trim
  return text.normalize("NFC").toLowerCase().trim();
}

/**
 * XP required to reach the NEXT level from the given level
 * Formula: 5L² + 50L + 100
 */
function xpFor(level) {
  return 5 * level * level + 50 * level + 100;
}

module.exports = { norm, xpFor };
