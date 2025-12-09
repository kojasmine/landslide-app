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

// --- SEARCH API (FIXED) ---
app.get('/api/search', async (req, res) => {
    const { q } = req.query; 
    
    if (!q || q.length < 1) return res.json([]);

    console.log("Searching for:", q);

    const query = `
        SELECT p.id, 
               t."PARID" as owner_name, 
               -- Create the full address for display
               CONCAT(t."ADRNO", ' ', t."ADRADD", ' ', t."ADRSTR") as address, 
               ST_X(ST_Centroid(p.geom)) as lng, 
               ST_Y(ST_Centroid(p.geom)) as lat
        FROM "tax_administration_s_real_estate" t
        -- Safer Join: Removes spaces to ensure IDs match
        JOIN "Parcels_real" p ON REPLACE(t."PARID", ' ', '') = REPLACE(p."PIN", ' ', '')
        WHERE 
           -- Check if the Search matches the ID
           t."PARID"::text ILIKE $1 
           OR
           -- Check if the Search matches the NUMBER (e.g. "5223")
           t."ADRNO"::text ILIKE $1
           OR
           -- Check if the Search matches the NAME (e.g. "Bradfield")
           t."ADRADD" ILIKE $1
           OR
           -- THE FIX: Check if Search matches "5223 Bradfield" combined
           CONCAT(t."ADRNO", ' ', t."ADRADD") ILIKE $1
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

// --- MAP CLICK API (FIXED) ---
app.get('/api/parcels', async (req, res) => {
    const { lat, lng } = req.query;
    
    const query = `
        SELECT p.id, 
               t."PARID" as owner_name,        
               CONCAT(t."ADRNO", ' ', t."ADRADD", ' ', t."ADRSTR") as address,    
               ST_AsGeoJSON(p.geom) as geometry
        FROM "Parcels_real" p
        -- Safer Join here too
        LEFT JOIN "tax_administration_s_real_estate" t ON REPLACE(p."PIN", ' ', '') = REPLACE(t."PARID", ' ', '')
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