const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();
const path = require('path'); // Move this up

const app = express();
app.use(cors());
app.use(express.json());

// Database Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// 1. Serve the Map (Frontend)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '/index.html'));
});

// 2. API Endpoint for Property Data
app.get('/api/parcels', async (req, res) => {
    const { lat, lng } = req.query;
    
    // Find the parcel closest to the click (or containing it)
    const query = `
        SELECT id, owner_name, address, ST_AsGeoJSON(geom) as geometry
        FROM parcels
        ORDER BY geom <-> ST_SetSRID(ST_Point($1, $2), 4326)
        LIMIT 1;
    `;
    
    try {
        // Note: PostGIS expects [Longitude, Latitude]
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