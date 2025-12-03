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

// --- 2. SEARCH API (Updated) ---
app.get('/api/search', async (req, res) => {
    const { q } = req.query; 
    
    if (!q || q.length < 1) return res.json([]);

    // Search by PIN or Street Name
    const query = `
        SELECT p.id, 
               p."PIN" as owner_name, 
               CONCAT(t."ADRNO", ' ', t."ADRSTR", ' ', t."ADRSUF") as address, 
               ST_X(ST_Centroid(p.geom)) as lng, 
               ST_Y(ST_Centroid(p.geom)) as lat
        FROM "Parcels_real" p
        LEFT JOIN "tax_administration_s_real_estate" t ON p."PIN" = t."PARID"
        WHERE t."ADRSTR" ILIKE $1 OR p."PIN" ILIKE $1
        LIMIT 5;
    `;

    try {
        const result = await pool.query(query, [`%${q}%`]);
        res.json(result.rows);
    } catch (err) {
        console.error("Search Error:", err);
        res.status(500).send("Search Error");
    }
});

// --- 3. GET PARCEL BY LOCATION (Address Join) ---
app.get('/api/parcels', async (req, res) => {
    const { lat, lng } = req.query;
    
    // SAFE QUERY: Real Address, PIN as Owner
    const query = `
        SELECT p.id, 
               p."PIN" as owner_name,            -- Using PIN to be safe
               CONCAT(t."ADRNO", ' ', t."ADRSTR", ' ', t."ADRSUF") as address, -- Real Address!
               ST_AsGeoJSON(p.geom) as geometry
        FROM "Parcels_real" p
        LEFT JOIN "tax_administration_s_real_estate" t 
        ON p."PIN" = t."PARID"                   -- Joining the tables
        ORDER BY p.geom <-> ST_SetSRID(ST_Point($1, $2), 4326)
        LIMIT 1;
    `;
    
    try {
        const result = await pool.query(query, [lng, lat]);
        res.json(result.rows);
    } catch (err) {
        console.error("Map Click Error:", err);
        res.status(500).send("Database Error: " + err.message); 
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});