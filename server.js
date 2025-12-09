const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '/index.html'));
});

// --- SMART SEARCH API (v20) ---
app.get('/api/search', async (req, res) => {
    let { q } = req.query; 
    
    if (!q || q.length < 1) return res.json([]);

    console.log("Original Search:", q);

    // 1. CLEAN THE SEARCH TERM
    // Remove common suffixes because the database might not have them.
    // e.g. "Bradfield Drive" becomes "Bradfield"
    let cleanQ = q.toLowerCase()
        .replace(/\bdrive\b|\bdr\b/g, '')
        .replace(/\bstreet\b|\bst\b/g, '')
        .replace(/\broad\b|\brd\b/g, '')
        .replace(/\blane\b|\bln\b/g, '')
        .replace(/\bavenue\b|\bave\b/g, '')
        .trim();

    console.log("Cleaned Search:", cleanQ);

    const query = `
        SELECT p.id, 
               t."PARID" as owner_name, 
               CONCAT(t."ADRNO", ' ', t."ADRSTR") as address, 
               ST_X(ST_Centroid(p.geom)) as lng, 
               ST_Y(ST_Centroid(p.geom)) as lat,
               ST_AsGeoJSON(p.geom) as geometry
        FROM taxdata t
        JOIN "Parcels_real" p ON REPLACE(t."PARID", ' ', '') = REPLACE(p."PIN", ' ', '')
        WHERE 
           -- Check Cleaned Address (e.g. "5223 Bradfield")
           CONCAT(t."ADRNO", ' ', t."ADRSTR") ILIKE $1
           OR
           -- Check Original Search (Just in case)
           CONCAT(t."ADRNO", ' ', t."ADRSTR") ILIKE $2
           OR
           -- Check ID
           t."PARID"::text ILIKE $2
        LIMIT 5;
    `;

    try {
        // Pass both the cleaned version and original version
        const result = await pool.query(query, [`%${cleanQ}%`, `%${q}%`]);
        res.json(result.rows);
    } catch (err) {
        console.error("Search Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- MAP CLICK API ---
app.get('/api/parcels', async (req, res) => {
    const { lat, lng } = req.query;
    
    const query = `
        SELECT p.id, 
               t."PARID" as owner_name,        
               CONCAT(t."ADRNO", ' ', t."ADRSTR") as address,    
               ST_AsGeoJSON(p.geom) as geometry
        FROM "Parcels_real" p
        LEFT JOIN taxdata t ON REPLACE(p."PIN", ' ', '') = REPLACE(t."PARID", ' ', '')
        ORDER BY p.geom <-> ST_SetSRID(ST_Point($1, $2), 4326)
        LIMIT 1;
    `;
    
    try {
        const result = await pool.query(query, [lng, lat]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send("Server Error");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});