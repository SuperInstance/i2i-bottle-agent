'use strict';

const crypto = require('crypto');

/**
 * Required I2I header fields every bottle must have.
 */
const REQUIRED_FIELDS = ['FROM', 'TO', 'TIMESTAMP', 'TYPE'];

/**
 * Bottle Validator — checks that I2I bottles have all required fields,
 * valid formatting, and optionally verifies integrity hashes.
 */
class BottleValidator {
  constructor(opts = {}) {
    this.strict = opts.strict !== false;
  }

  /**
   * Validate a parsed bottle object.
   * @param {object} bottle - The parsed bottle { headers: {}, body: string, raw: string, file?: string }
   * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
   */
  validate(bottle) {
    const errors = [];
    const warnings = [];

    if (!bottle) {
      return { valid: false, errors: ['Bottle is null or undefined'], warnings: [] };
    }

    if (!bottle.headers || typeof bottle.headers !== 'object') {
      return { valid: false, errors: ['Bottle has no headers object'], warnings: [] };
    }

    // 1. Check for I2I bottle marker
    if (!bottle.headers['$marker']) {
      errors.push('Missing I2I bottle marker [I2I:BOTTLE:...]');
    } else {
      const markerMatch = bottle.headers['$marker'].match(/^I2I:BOTTLE:(\S+)$/);
      if (!markerMatch) {
        errors.push(`Malformed I2I marker: "${bottle.headers['$marker']}". Expected format I2I:BOTTLE:TIMESTAMP`);
      }
    }

    // 2. Check required I2I fields
    for (const field of REQUIRED_FIELDS) {
      const val = bottle.headers[field];
      if (!val || (typeof val === 'string' && val.trim() === '')) {
        errors.push(`Missing required header: ${field}`);
      }
    }

    // 3. Validate TIMESTAMP format if present
    if (bottle.headers['TIMESTAMP']) {
      const ts = bottle.headers['TIMESTAMP'].trim();
      // ISO 8601
      const isoMatch = ts.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/);
      if (!isoMatch) {
        warnings.push(`TIMESTAMP "${ts}" is not ISO 8601 format (YYYY-MM-DDTHH:mm:ssZ)`);
      }
    }

    // 4. Check TYPE is not empty / likely valid
    if (bottle.headers['TYPE']) {
      const typeVal = bottle.headers['TYPE'].trim();
      const validTypes = [
        'TASK', 'STATUS', 'CHECKPOINT', 'BLOCKER', 'DELIVERABLE',
        'BOTTLE', 'ACK', 'SYNTHESIS', 'CHALLENGE', 'SESSION',
        'SPLINE', 'REFLECT', 'PROMOTE', 'RESPONSE', 'DISPATCH'
      ];
      // Simple heuristic: type should start with a known keyword
      const typePrefix = typeVal.split(/[ —–\-]/)[0];
      if (!validTypes.includes(typePrefix) && this.strict) {
        warnings.push(`TYPE "${typeVal}" does not start with a known bottle type prefix`);
      }

      // Check TYPE format — should have description after dash
      if (!typeVal.includes('—') && !typeVal.includes('-') && !typeVal.includes(' ')) {
        warnings.push(`TYPE "${typeVal}" has no description (e.g. "BOTTLE — description")`);
      }
    }

    // 5. Integrity hash check if present
    // Headers may include INTEGRITY as optional field
    if (bottle.headers['INTEGRITY']) {
      const integrityHash = bottle.headers['INTEGRITY'].trim();
      if (!/^[a-f0-9]{64}$/i.test(integrityHash)) {
        errors.push(`INTEGRITY hash "${integrityHash}" is not a valid SHA-256 hex digest`);
      } else if (this.strict) {
        // Verify the hash against the bottle body
        const computed = this._computeIntegrity(bottle);
        if (computed !== integrityHash) {
          errors.push(`INTEGRITY MISMATCH: computed ${computed}, header says ${integrityHash}`);
        }
      }
    }

    // 6. Ensure body is present
    if (!bottle.body || bottle.body.trim() === '') {
      warnings.push('Bottle body is empty — no content');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Compute SHA-256 integrity hash for a bottle.
   * Hashes the raw body text + sorted headers (excluding INTEGRITY itself).
   * @param {object} bottle
   * @returns {string} hex digest
   */
  _computeIntegrity(bottle) {
    const headerParts = Object.entries(bottle.headers)
      .filter(([k]) => k !== 'INTEGRITY' && k !== '$marker' && k !== '$subject')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');

    const payload = headerParts + '\n\n' + (bottle.body || '');
    return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
  }

  /**
   * Add an INTEGRITY hash to a bottle's headers if not present.
   * @param {object} bottle
   * @returns {object} the bottle with integrity header added
   */
  stampIntegrity(bottle) {
    const hash = this._computeIntegrity(bottle);
    bottle.headers['INTEGRITY'] = hash;
    return bottle;
  }
}

module.exports = { BottleValidator, REQUIRED_FIELDS };
