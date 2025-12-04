const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Database Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// --- 1. SERVE THE APP ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '/index.html'));
});

// --- 2. SEARCH API ---
app.get('/api/search', async (req, res) => {
    const { q } = req.query;
    
    // If search is empty, return nothing
    if (!q || q.length < 1) return res.json([]);

    const words = q.trim().split(/\s+/);
    
    // We search the Tax Table columns (Number or Street) OR the Map PIN
    // Note: We cast ADRNO to text because it is an integer in your database
    const conditions = words.map((_, index) => 
        `(t."ADRNO"::text ILIKE $${index + 1} OR t."ADRSTR" ILIKE $${index + 1} OR p."PIN" ILIKE $${index + 1})`
    ).join(' AND ');

    const searchTerms = words.map(w => `%${w}%`);

    const query = `
        SELECT p.id, 
               p."PIN" as owner_name, 
               -- GLUE THE ADDRESS TOGETHER: Number + Street + Suffix + City
               CONCAT(t."ADRNO", ' ', t."ADRSTR", ' ', t."ADRSUF", ', ', t."CITYNAME") as address,
               ST_X(ST_Centroid(p.geom)) as lng, 
               ST_Y(ST_Centroid(p.geom)) as lat
        FROM "Parcels_real" p
        LEFT JOIN "tax_administration_s_real_estate" t 
        ON p."PIN" = t."PARID"  -- <--- THE FIX: Matching PIN to PARID
        WHERE (${conditions})
        LIMIT 5;
    `;

    try {
        const result = await pool.query(query, searchTerms);
        res.json(result.rows);
    } catch (err) {
        console.error("Search Error:", err);
        res.status(500).send("Search Error: " + err.message);
    }
});

// --- 3. GET PARCEL BY LOCATION (Clicking) ---
app.get('/api/parcels', async (req, res) => {
    const { lat, lng } = req.query;
    
    const query = `
        SELECT p.id, 
               p."PIN" as owner_name,        
               CONCAT(t."ADRNO", ' ', t."ADRSTR", ' ', t."ADRSUF", ', ', t."CITYNAME") as address,    
               ST_AsGeoJSON(p.geom) as geometry
        FROM "Parcels_real" p
        LEFT JOIN "tax_administration_s_real_estate" t 
        ON p."PIN" = t."PARID" -- <--- THE FIX: Matching PIN to PARID
        ORDER BY p.geom <-> ST_SetSRID(ST_Point($1, $2), 4326)
        LIMIT 1;
    `;
    
    try {
        const result = await pool.query(query, [lng, lat]);
        res.json(result.rows);
    } catch (err) {
        console.error("Map Click Error:", err);
        res.status(500).send("Server Error");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});