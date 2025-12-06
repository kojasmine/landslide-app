// server.js
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();

// Basic middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Serve static files from project root (index.html + any assets)
app.use(express.static(path.join(__dirname)));

// Rate limiting for APIs
const apiLimiter = rateLimit({
  windowMs: 1000 * 5, // 5 seconds
  max: 12,            // max 12 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // If using Heroku-like managed Postgres with SSL, keep this.
  // In local development you might omit ssl or set appropriately.
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// Simple health endpoint
app.get('/health', (req, res) => res.json({ ok: true }));

// SEARCH endpoint
// Returns up to 5 matches with centroid + full geometry (GeoJSON) for frontend use.
app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json([]);

    // parameterized query - returns geometry as GeoJSON
    const sql = `
      SELECT id,
             "PIN"       AS owner_name,
             "PARCEL_TYP" AS address,
             ST_X(ST_Centroid(geom)) AS lng,
             ST_Y(ST_Centroid(geom)) AS lat,
             ST_AsGeoJSON(geom) AS geometry
      FROM "Parcels_real"
      WHERE "PARCEL_TYP" ILIKE $1 OR "PIN" ILIKE $1
      LIMIT 5;
    `;
    const { rows } = await pool.query(sql, [`%${q}%`]);
    return res.json(rows);
  } catch (err) {
    console.error('Search error:', err);
    return res.status(500).json({ error: 'Search error' });
  }
});

// GET PARCEL BY LOCATION (click)
// First tries to find parcel containing the point. If none found, returns nearest parcel.
app.get('/api/parcels', async (req, res) => {
  try {
    const lat = parseFloat(req
