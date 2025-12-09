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

// --- SEARCH API (Using table 'taxdata') ---
app.get('/api/search', async (req, res) => {
    const { q } = req.query; 
    
    if (!q || q.length < 1) return res.json([]);

    console.log("Searching table 'taxdata' for:", q);

    const query = `
        SELECT p.id, 
               t."PARID" as owner_name, 
               -- Combine Number + Street Name
               CONCAT(t."ADRNO", ' ', t."ADRSTR") as address, 
               ST_X(ST_Centroid(p.geom)) as lng, 
               ST_Y(ST_Centroid(p.geom)) as lat
        FROM taxdata t
        JOIN "Parcels_real" p ON REPLACE(t."PARID", ' ', '') = REPLACE(p."PIN", ' ', '')
        WHERE 
           -- 1. Check Full Address
           CONCAT(t."ADRNO", ' ', t."ADRSTR") ILIKE $1
           OR
           -- 2. Check PIN/PARID
           t."PARID"::text ILIKE $1
           OR
           -- 3. Check Street Name only
           t."ADRSTR" ILIKE $1
        LIMIT 5;
    `;

    try {
        const result = await pool.query(query, [`%${q}%`]);
        console.log("Found:", result.rows.length);
        res.json(result.rows);
    } catch (err) {
        console.error("Search Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- MAP CLICK API (Using table 'taxdata') ---
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