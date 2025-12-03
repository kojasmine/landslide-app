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

    // This query joins the map to the address table
    const query = `
        SELECT 
            p.id, 
            'Current Resident' as owner_name, 
            
            -- Combine: House Number + Street Name + Suffix (e.g., 7114 NORWALK ST)
            CONCAT(t."ADRNO", ' ', t."ADRSTR", ' ', t."ADRSUF") as address,
            
            ST_X(ST_Centroid(p.geom)) as lng, 
            ST_Y(ST_Centroid(p.geom)) as lat
        FROM "Parcels_real" p
        LEFT JOIN "tax_info" t ON p."PIN" = t."PARID"
        
        -- Search by Street Name or PIN
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

// --- 3. CLICK API (Updated) ---
app.get('/api/parcels', async (req, res) => {
    const { lat, lng } = req.query;
    
    const query = `
        SELECT 
            p.id, 
            'Current Resident' as owner_name,
            
            -- Combine: House Number + Street Name + Suffix
            CONCAT(t."ADRNO", ' ', t."ADRSTR", ' ', t."ADRSUF") as address,
            
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