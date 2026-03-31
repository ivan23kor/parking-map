const key = process.env.GEMINI_API_KEY;
if (!key) { console.error("GEMINI_API_KEY not set"); process.exit(1); }

const res = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${key}`,
  { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] }) }
);

const data = await res.json();
console.log(data.candidates?.[0]?.content?.parts?.[0]?.text ?? JSON.stringify(data, null, 2));
