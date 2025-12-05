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

// --- SEARCH API ---
app.get('/api/search', async (req, res) => {
    const { q } = req.query;
    if (!q || q.length < 1) return res.json([]);

    const words = q.trim().split(/\s+/);
    
    // SAFE SEARCH: Cast numbers to text so they don't crash
    const conditions = words.map((_, index) => 
        `(t."ADRNO"::text ILIKE $${index + 1} OR t."ADRSTR" ILIKE $${index + 1} OR p."PIN" ILIKE $${index + 1})`
    ).join(' AND ');

    const searchTerms = words.map(w => `%${w}%`);

    const query = `
        SELECT p.id, 
               p."PIN" as owner_name, 
               -- Handle NULL addresses gracefully
               COALESCE(CONCAT(t."ADRNO", ' ', t."ADRSTR", ' ', t."ADRSUF", ', ', t."CITYNAME"), 'Address Unknown') as address,
               ST_X(ST_Centroid(p.geom)) as lng, 
               ST_Y(ST_Centroid(p.geom)) as lat,
               ST_AsGeoJSON(p.geom) as geometry
        FROM "Parcels_real" p
        LEFT JOIN "tax_administration_s_real_estate" t 
        ON p."PIN" = t."PARID"
        WHERE (${conditions})
        LIMIT 5;
    `;

    try {
        const result = await pool.query(query, searchTerms);
        res.json(result.rows);
    } catch (err) {
        console.error("Search Error:", err);
        // Don't crash the server, just send empty list
        res.json([]);
    }
});

// --- MAP CLICK API ---
app.get('/api/parcels', async (req, res) => {
    const { lat, lng } = req.query;
    
    const query = `
        SELECT p.id, 
               p."PIN" as owner_name,        
               COALESCE(CONCAT(t."ADRNO", ' ', t."ADRSTR", ' ', t."ADRSUF", ', ', t."CITYNAME"), 'No Address Info') as address,    
               ST_AsGeoJSON(p.geom) as geometry
        FROM "Parcels_real" p
        LEFT JOIN "tax_administration_s_real_estate" t 
        ON p."PIN" = t."PARID"
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