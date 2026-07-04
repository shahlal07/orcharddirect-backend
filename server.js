/**
 * OrchardDirect backend - UPDATED with JWT Authentication
 */
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken"); // Ensure this is installed
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// Load secrets from env variables
const JWT_SECRET = process.env.JWT_SECRET || "change-this-to-a-very-long-random-string";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";

// ... [Keep your existing readJSON/writeJSON functions] ...

// Middleware to verify Admin JWT
function verifyAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: "Access denied." });
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid token." });
    next();
  });
}

// Login route
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Wrong password." });
  
  const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

// Protect your admin routes by adding verifyAdmin as middleware:
app.get("/api/admin/data", verifyAdmin, (req, res) => {
  res.json({ products, settings, discounts });
});

app.put("/api/admin/products", verifyAdmin, (req, res) => { /* ... */ });
app.put("/api/admin/settings", verifyAdmin, (req, res) => { /* ... */ });
app.put("/api/admin/discounts", verifyAdmin, (req, res) => { /* ... */ });

// ... [Keep your existing public routes and checkout logic] ...
