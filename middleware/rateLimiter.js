const rateLimit = require("express-rate-limit");

// Vercel berada di belakang proxy dan mengirim Forwarded/X-Forwarded-For.\n// Gunakan IP yang sudah dinormalisasi Express agar rate-limit tidak memicu\n// ERR_ERL_FORWARDED_HEADER pada serverless runtime.

// Rate limiting middleware
const limiter = rateLimit({
  keyGenerator: (req) => req.ip,
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error:
      "Terlalu banyak request dari IP ini, silakan coba lagi setelah 15 menit",
  },
});

module.exports = limiter;
