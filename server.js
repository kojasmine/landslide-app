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

// --- 1. SERVE THE APP (Frontend) ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '/index.html'));
});

// --- 2. SEARCH API (New!) ---
app.get('/api/search', async (req, res) => {
    const { q } = req.query; // The user's search text
    
    if (!q || q.length < 1) return res.json([]);

    // We search the 'PARCEL_TYP' column (Address placeholder) AND 'PIN' (Owner placeholder)
    // The % symbols allow for partial matching (e.g. "0102" finds "0102 14...")
    const query = `
        SELECT id, 
               "PIN" as owner_name, 
               "PARCEL_TYP" as address, 
               ST_X(ST_Centroid(geom)) as lng, 
               ST_Y(ST_Centroid(geom)) as lat
        FROM "Parcels_real"
        WHERE "PARCEL_TYP" ILIKE $1 OR "PIN" ILIKE $1
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

// --- 3. GET PARCEL BY LOCATION (Clicking) ---
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
        console.error("Map Click Error:", err);
        res.status(500).send("Server Error");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});