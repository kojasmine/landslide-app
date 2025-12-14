// ================================
// COMPLETE server.js REPLACEMENT
// Fix: serves index.html on "/"
// Keeps: login/register, parcels/search, cloud save/load/delete
// Adds: uploads static folder, image upload/delete, AI analyze placeholder
// ================================

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// -------------------------------
// Ensure uploads folder exists
// -------------------------------
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// Serve uploaded images
app.use('/uploads', express.static(UPLOAD_DIR));

// Serve other static files if you add any later
app.use(express.static(__dirname));

// -------------------------------
// Database
// -------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// -------------------------------
// Home page
// -------------------------------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ================================
// 1) AUTHENTICATION
// ================================
app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;
  try {
    const check = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (check.rows.length > 0) return res.json({ success: false, message: "Email exists" });

    const hash = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO users (email, password) VALUES ($1, $2)', [email, hash]);

    const user = await pool.query('SELECT id, email FROM users WHERE email = $1', [email]);
    res.json({ success: true, user: user.rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.json({ success: false, message: "User not found" });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.json({ success: false, message: "Wrong password" });

    res.json({ success: true, user: { id: user.id, email: user.email } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ================================
// 2) IMAGE UPLOAD / DELETE
// Uses table: stake_images(id, stake_id, user_id, filename, created_at)
// ================================
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^\w.\-]+/g, '_');
    cb(null, `${Date.now()}_${safeName}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

app.post('/api/image/upload', upload.single('image'), async (req, res) => {
  try {
    const { stakeId, userId } = req.body;
    if (!stakeId || !userId) return res.status(400).json({ success: false, message: "stakeId and userId required" });

    await pool.query(
      'INSERT INTO stake_images (stake_id, user_id, filename) VALUES ($1, $2, $3)',
      [stakeId, userId, req.file.filename]
    );

    res.json({ success: true, filename: req.file.filename, url: `/uploads/${req.file.filename}` });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.delete('/api/image/:filename', async (req, res) => {
  try {
    const file = req.params.filename;

    // Remove DB record
    await pool.query('DELETE FROM stake_images WHERE filename = $1', [file]);

    // Remove file if exists
    const fp = path.join(UPLOAD_DIR, file);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ================================
// 3) AI ANALYZE (placeholder)
// ================================
app.post('/api/ai/analyze', async (req, res) => {
  try {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ success: false, message: "filename required" });

    // Placeholder: later we connect to real AI vision.
    res.json({ success: true, analysis: `AI analysis result for ${filename}` });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ================================
// 4) CLOUD PROJECT SAVE / LOAD / DELETE
// ================================
app.post('/api/cloud/save', async (req, res) => {
  const { id, userId, name, data } = req.body;

  try {
    if (!userId || !name || !data) return res.status(400).json({ success: false, message: "Missing fields" });

    if (!id) {
      const check = await pool.query(
        'SELECT id FROM user_projects WHERE user_id = $1 AND name = $2',
        [userId, name]
      );
      if (check.rows.length > 0) return res.json({ success: false, message: "File name already exists!" });

      const result = await pool.query(
        'INSERT INTO user_projects (user_id, name, data) VALUES ($1, $2, $3) RETURNING id',
        [userId, name, JSON.stringify(data)]
      );
      return res.json({ success: true, mode: 'create', newId: result.rows[0].id });
    } else {
      await pool.query(
        'UPDATE user_projects SET data = $1, name = $2, updated_at = NOW() WHERE id = $3 AND user_id = $4',
        [JSON.stringify(data), name, id, userId]
      );
      return res.json({ success: true, mode: 'update', newId: id });
    }
  } catch (err) {
    console.error("Save Error:", err.message);
    res.status(500).json({ success: false, message: "Server Error (File too big?)" });
  }
});

app.get('/api/cloud/load/:userId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM user_projects WHERE user_id = $1 ORDER BY updated_at DESC',
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/cloud/delete/:projectId', async (req, res) => {
  try {
    await pool.query('DELETE FROM user_projects WHERE id = $1', [req.params.projectId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ================================
// 5) MAP DATA (search + parcels)
// ================================
app.get('/api/search', async (req, res) => {
  let { q } = req.query;
  if (!q || q.length < 1) return res.json([]);

  let cleanQ = q.toLowerCase()
    .replace(/\bdrive\b|\bdr\b/g, '')
    .replace(/\bstreet\b|\bst\b/g, '')
    .trim();

  const query = `
    SELECT p.id, t."PARID" as owner_name, CONCAT(t."ADRNO", ' ', t."ADRSTR") as address,
           ST_X(ST_Centroid(p.geom)) as lng, ST_Y(ST_Centroid(p.geom)) as lat,
           ST_AsGeoJSON(p.geom) as geometry
    FROM taxdata t JOIN "Parcels_real" p ON REPLACE(t."PARID", ' ', '') = REPLACE(p."PIN", ' ', '')
    WHERE CONCAT(t."ADRNO", ' ', t."ADRSTR") ILIKE $1
       OR CONCAT(t."ADRNO", ' ', t."ADRSTR") ILIKE $2
       OR t."PARID"::text ILIKE $2
    LIMIT 5;
  `;

  try {
    const result = await pool.query(query, [`%${cleanQ}%`, `%${q}%`]);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/parcels', async (req, res) => {
  const { lat, lng } = req.query;

  const query = `
    SELECT p.id, t."PARID" as owner_name, CONCAT(t."ADRNO", ' ', t."ADRSTR") as address,
           ST_AsGeoJSON(p.geom) as geometry
    FROM "Parcels_real" p LEFT JOIN taxdata t ON REPLACE(p."PIN", ' ', '') = REPLACE(t."PARID", ' ', '')
    ORDER BY p.geom <-> ST_SetSRID(ST_Point($1, $2), 4326)
    LIMIT 1;
  `;

  try {
    const result = await pool.query(query, [lng, lat]);
    res.json(result.rows);
  } catch (e) {
    res.status(500).send("Error");
  }
});

// -------------------------------
// Start server
// -------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
