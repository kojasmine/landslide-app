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

// --- ROBUST SEARCH API (Split Method) ---
app.get('/api/search', async (req, res) => {
    const { q } = req.query; 
    
    if (!q || q.length < 1) return res.json([]);

    console.log("Searching for:", q);

    try {
        // STEP 1: Find the Address/Owner in the Tax Table first
        // We cast everything to ::text to prevent "Integer" errors
        const taxQuery = `
            SELECT "PARID", "ADRNO", "ADRSTR"
            FROM taxdata
            WHERE 
                CONCAT("ADRNO", ' ', "ADRSTR") ILIKE $1
                OR "PARID"::text ILIKE $1
                OR "ADRSTR" ILIKE $1
            LIMIT 5;
        `;
        
        const taxResults = await pool.query(taxQuery, [`%${q}%`]);
        
        if (taxResults.rows.length === 0) {
            return res.json([]); // No address found
        }

        // STEP 2: Find the matching Map Shapes for these properties
        // We create a list of IDs found in Step 1
        const foundIDs = taxResults.rows.map(r => r.PARID);
        
        // We look for these IDs in the Parcels_real table
        // We use REPLACE to handle spaces (e.g. "0401 23" vs "040123")
        const mapQuery = `
            SELECT id, "PIN", ST_X(ST_Centroid(geom)) as lng, ST_Y(ST_Centroid(geom)) as lat
            FROM "Parcels_real"
            WHERE REPLACE("PIN", ' ', '') = ANY($1)
        `;
        
        // Clean spaces from the IDs for the comparison
        const cleanIDs = foundIDs.map(id => id.replace(/ /g, ''));
        const mapResults = await pool.query(mapQuery, [cleanIDs]);

        // STEP 3: Combine the data
        const finalResults = mapResults.rows.map(mapItem => {
            // Find the matching tax info
            const taxItem = taxResults.rows.find(t => t.PARID.replace(/ /g, '') === mapItem.PIN.replace(/ /g, ''));
            return {
                id: mapItem.id,
                owner_name: taxItem ? taxItem.PARID : mapItem.PIN,
                address: taxItem ? `${taxItem.ADRNO} ${taxItem.ADRSTR}` : "Unknown Address",
                lat: mapItem.lat,
                lng: mapItem.lng
            };
        });

        res.json(finalResults);

    } catch (err) {
        console.error("Search Error:", err.message);
        // Send the actual error message to the browser so we can see it
        res.status(500).json({ error: err.message });
    }
});

// --- MAP CLICK API ---
app.get('/api/parcels', async (req, res) => {
    const { lat, lng } = req.query;
    
    const query = `
        SELECT p.id, 
               t."PARID" as owner_name,        
               CONCAT(t."ADRNO", ' ', t."ADRSTR") as address,    
               ST_AsGeoJSON(p.geom) as geometry
        FROM "Parcels_real" p
        LEFT JOIN taxdata t ON REPLACE(p."PIN", ' ', '') = REPLACE(t."PARID", ' ', '')
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