// ================================
// COMPLETE server.js REPLACEMENT
// Image upload + delete + AI analyze
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

// Serve uploaded images
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ================================
// DATABASE
// ================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ================================
// AUTH (unchanged logic)
// ================================
app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;
  const check = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
  if (check.rows.length) return res.json({ success:false, message:'Email exists' });

  const hash = await bcrypt.hash(password, 10);
  const user = await pool.query(
    'INSERT INTO users (email,password) VALUES ($1,$2) RETURNING id,email',
    [email, hash]
  );
  res.json({ success:true, user:user.rows[0] });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const result = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
  if (!result.rows.length) return res.json({ success:false });

  const user = result.rows[0];
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.json({ success:false });

  res.json({ success:true, user:{ id:user.id, email:user.email } });
});

// ================================
// FILE STORAGE (UPLOADS)
// ================================
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (_, file, cb) => {
    const safe = Date.now() + '_' + file.originalname.replace(/\s+/g,'_');
    cb(null, safe);
  }
});

const upload = multer({ storage });

// ================================
// IMAGE UPLOAD
// ================================
app.post('/api/image/upload', upload.single('image'), async (req, res) => {
  const { stakeId, userId } = req.body;

  await pool.query(
    'INSERT INTO stake_images (stake_id,user_id,filename) VALUES ($1,$2,$3)',
    [stakeId, userId, req.file.filename]
  );

  res.json({ success:true, filename:req.file.filename, url:'/uploads/'+req.file.filename });
});

// ================================
// IMAGE DELETE
// ================================
app.delete('/api/image/:filename', async (req, res) => {
  const file = req.params.filename;

  await pool.query('DELETE FROM stake_images WHERE filename=$1', [file]);
  fs.unlinkSync(path.join('uploads', file));

  res.json({ success:true });
});

// ================================
// AI IMAGE ANALYSIS (placeholder)
// ================================
app.post('/api/ai/analyze', async (req, res) => {
  const { filename } = req.body;

  res.json({
    success:true,
    analysis:`AI analysis result for ${filename}`
  });
});

// ================================
// SERVER
// ================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port', PORT));
