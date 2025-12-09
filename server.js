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

// --- SEARCH API (Fixed with JOIN) ---
app.get('/api/search', async (req, res) => {
    const { q } = req.query; 
    
    if (!q || q.length < 1) return res.json([]);

    // Logic:
    // 1. We start with the Data Table (t) to find the address.
    // 2. We JOIN the Map Table (p) to get the coordinates (Lat/Lng) for flying.
    // 3. We construct the address by combining Number (ADRNO) + Name (ADRADD).
    
    const query = `
        SELECT p.id, 
               t."PARID" as owner_name, 
               CONCAT(t."ADRNO", ' ', t."ADRADD", ' ', t."ADRSTR") as address, 
               ST_X(ST_Centroid(p.geom)) as lng, 
               ST_Y(ST_Centroid(p.geom)) as lat
        FROM "tax_administration_s_real_estate" t
        JOIN "Parcels_real" p ON t."PARID" = p."PIN"
        WHERE t."PARID"::text ILIKE $1 
           OR t."ADRADD" ILIKE $1
           OR t."ADRNO"::text ILIKE $1
        LIMIT 5;
    `;

    try {
        const result = await pool.query(query, [`%${q}%`]);
        res.json(result.rows);
    } catch (err) {
        console.error("Search Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- MAP CLICK API (Fixed with JOIN) ---
app.get('/api/parcels', async (req, res) => {
    const { lat, lng } = req.query;
    
    // Logic:
    // 1. We find the Shape (p.geom) that you clicked on.
    // 2. We JOIN the Tax Table (t) to get the address text.
    
    const query = `
        SELECT p.id, 
               t."PARID" as owner_name,        
               CONCAT(t."ADRNO", ' ', t."ADRADD", ' ', t."ADRSTR") as address,    
               ST_AsGeoJSON(p.geom) as geometry
        FROM "Parcels_real" p
        LEFT JOIN "tax_administration_s_real_estate" t ON p."PIN" = t."PARID"
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