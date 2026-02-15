require("dotenv").config();

const { startOpenAiWorkers } = require("./aiQueue");

async function main() {
    const workers = await startOpenAiWorkers();
    console.log(`[AI_WORKER] started ${workers.length} worker(s).`);
}

main().catch((e) => {
    console.error("[AI_WORKER] failed to start:", e?.stack || e);
    process.exit(1);
});

