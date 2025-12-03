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

// --- 2. SEARCH API (Bulletproof Version) ---
app.get('/api/search', async (req, res) => {
    const { q } = req.query; 
    
    // Debug Log: Check Render Logs to see if this prints
    console.log("Search requested for:", q);

    if (!q || q.length < 1) return res.json([]);

    // We search the Street Name OR the Number OR the ID
    // We use CAST(ADRNO as TEXT) to prevent errors if the number is an Integer
    const query = `
        SELECT p.id, 
               t."PARID" as owner_name,  
               CONCAT(t."ADRNO", ' ', t."ADRADD") as address,
               ST_X(ST_Centroid(p.geom)) as lng, 
               ST_Y(ST_Centroid(p.geom)) as lat
        FROM "Parcels_real" p
        JOIN "tax_info" t ON p."PIN" = t."PARID"
        WHERE t."ADRADD" ILIKE $1 
           OR CAST(t."ADRNO" AS TEXT) ILIKE $1 
           OR t."PARID" ILIKE $1
        LIMIT 5;
    `;

    try {
        const result = await pool.query(query, [`%${q}%`]);
        console.log(`Found ${result.rows.length} results`);
        res.json(result.rows);
    } catch (err) {
        console.error("Search SQL Error:", err);
        res.status(500).send("Database Error");
    }
});

// --- 3. CLICK API (Fail-Safe) ---
app.get('/api/parcels', async (req, res) => {
    const { lat, lng } = req.query;
    
    // Tries to find Linked Data, but falls back to Map Data if missing
    const query = `
        SELECT p.id, 
               COALESCE(t."PARID", p."PIN") as owner_name,        
               COALESCE(CONCAT(t."ADRNO", ' ', t."ADRADD"), 'Address Not Linked') as address,    
               ST_AsGeoJSON(p.geom) as geometry
        FROM "Parcels_real" p
        LEFT JOIN "tax_info" t ON p."PIN" = t."PARID"
        ORDER BY p.geom <-> ST_SetSRID(ST_Point($1, $2), 4326)
        LIMIT 1;
    `;
    
    try {
        const result = await pool.query(query, [lng, lat]);
        res.json(result.rows);
    } catch (err) {
        console.error("Click Error:", err);
        res.status(500).send("Server Error");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});