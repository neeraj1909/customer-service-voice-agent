"""Run a controlled Pipecat text pipeline against fictional local order data.

See docs/framework-spike.md for isolated setup and execution.
"""

import asyncio
import tempfile
from pathlib import Path

from pipecat.frames.frames import EndFrame, TextFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineWorker
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.workers.runner import WorkerRunner

from customer_service.tools import Store


class OrderLookup(FrameProcessor):
    """Turn one fixed test frame into the actual local tool's result."""

    def __init__(self, store: Store):
        super().__init__()
        self.store = store

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, TextFrame):
            if frame.text != "ord-a-100":
                raise ValueError("unexpected fixture")
            result = self.store.order("cust-a", frame.text)
            await self.push_frame(TextFrame(f"{result['id']}:{result['status']}"), direction)
        else:
            await self.push_frame(frame, direction)


class Capture(FrameProcessor):
    def __init__(self):
        super().__init__()
        self.texts = []

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, TextFrame):
            self.texts.append(frame.text)
        await self.push_frame(frame, direction)


async def run(store: Store):
    expected = {"id": "ord-a-100", "status": "shipped"}
    if store.order("cust-a", "ord-a-100") != expected:
        raise AssertionError("direct tool result differed from the fixture")
    sink = Capture()
    worker = PipelineWorker(Pipeline([OrderLookup(store), sink]), enable_rtvi=False)
    runner = WorkerRunner(handle_sigint=False, handle_sigterm=False)
    await runner.add_workers(worker)
    await worker.queue_frames([TextFrame("ord-a-100"), EndFrame()])
    await asyncio.wait_for(runner.run(), timeout=20)
    if sink.texts != ["ord-a-100:shipped"]:
        raise AssertionError(f"unexpected pipeline output: {sink.texts!r}")
    print("PIPELINE_SERVICE_TOOL_OK", sink.texts)


def main():
    with tempfile.TemporaryDirectory(prefix="pipecat-order-spike-") as directory:
        asyncio.run(run(Store(Path(directory) / "fictional.sqlite")))


if __name__ == "__main__":
    main()
