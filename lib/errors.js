'use strict';
// TbError: an error with an HTTP status; http sends it as { "error": message } (D21).
class TbError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = { TbError };
