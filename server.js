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

// Serve Frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '/index.html'));
});

// --- SEARCH API (The part that was likely missing/broken) ---
app.get('/api/search', async (req, res) => {
    const { q } = req.query; 
    
    if (!q || q.length < 1) return res.json([]);

    console.log("Searching for:", q); // This prints to Render Logs

    // We search PIN and PARCEL_TYP.
    // We cast "PIN" to text (::text) so it doesn't crash if the user types letters.
    const query = `
        SELECT id, 
               "PIN" as owner_name, 
               "PARCEL_TYP" as address, 
               ST_X(ST_Centroid(geom)) as lng, 
               ST_Y(ST_Centroid(geom)) as lat
        FROM "Parcels_real"
        WHERE "PIN"::text ILIKE $1 OR "PARCEL_TYP" ILIKE $1
        LIMIT 5;
    `;

    try {
        const result = await pool.query(query, [`%${q}%`]);
        console.log("Found rows:", result.rows.length);
        res.json(result.rows);
    } catch (err) {
        console.error("Search Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// Click Map API
app.get('/api/parcels', async (req, res) => {
    const { lat, lng } = req.query;
    
    const query = `
        SELECT id, 
               "PIN" as owner_name,        
               "PARCEL_TYP" as address,    
               ST_AsGeoJSON(geom) as geometry
        FROM "Parcels_real"                
        ORDER BY geom <-> ST_SetSRID(ST_Point($1, $2), 4326)
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