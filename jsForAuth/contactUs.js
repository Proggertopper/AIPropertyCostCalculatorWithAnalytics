require("dotenv").config();
const express = require("express");
const router = express.Router();
const pool = require("./db");
const bodyParser = require("body-parser");
const { Resend } = require("resend");

router.use(bodyParser.json());

let resend;

function getResend() {
    if (!resend) {
        if (!process.env.RESEND_API_KEY) {
            throw new Error("RESEND_API_KEY is missing");
        }
        resend = new Resend(process.env.RESEND_API_KEY);
    }
    return resend;
}

router.post("/api/contact", async (req, res) => {
    try {
        const { name, email, message } = req.body;

        if (!name || !email || !message) {
            return res.status(400).json({ error: "All fields are required" });
        }

        const userId = req.session ? req.session.userId : null;

        await pool.query(
            `
            INSERT INTO contact_messages (user_id, name, email, message)
            VALUES ($1, $2, $3, $4)
            `,
            [userId, name, email, message]
        );

        const resend = getResend();

        await resend.emails.send({
            from: process.env.EMAIL_FROM,
            to: process.env.EMAIL_TO,
            subject: "New contact message",
            text: `
Name: ${name}
Email: ${email}

Message:
${message}
            `,
        });

        res.json({ success: true });

    } catch (err) {
        console.error("CONTACT ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

module.exports = router;