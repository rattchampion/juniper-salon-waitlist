import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities";
import { writeHeartbeat } from "./store";
import { TASK_QUEUE } from "./types";

async function run(): Promise<void> {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  });
  const worker = await Worker.create({
    connection,
    namespace: "default",
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve("./workflows"),
    activities,
  });

  // The staff screen shows a clear warning if this stops, so Lena never
  // assumes people are still being texted when they are not.
  writeHeartbeat();
  const beat = setInterval(writeHeartbeat, 5_000);
  console.log(`Worker is polling the ${TASK_QUEUE} task queue.`);
  try {
    await worker.run();
  } finally {
    clearInterval(beat);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
