#!/usr/bin/env python3
"""
DeepSeek-OCR vLLM Server
FastAPI wrapper for DeepSeek-OCR with vLLM backend
"""

import os
import sys
import asyncio
import io
import tempfile
from typing import List, Optional
from pathlib import Path

import uvicorn
from fastapi import FastAPI, UploadFile, File, HTTPException, BackgroundTasks, Form
from typing import Optional
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import torch
import fitz  # PyMuPDF
from PIL import Image
from tqdm import tqdm

# Add current directory to Python path
sys.path.insert(0, '/app/DeepSeek-OCR-vllm')

# Set environment variables for vLLM compatibility
if torch.version.cuda == '11.8':
    os.environ["TRITON_PTXAS_PATH"] = "/usr/local/cuda-11.8/bin/ptxas"
os.environ['VLLM_USE_V1'] = '0'
os.environ["CUDA_VISIBLE_DEVICES"] = '0'

# Import DeepSeek-OCR components
from config import INPUT_PATH, OUTPUT_PATH, PROMPT, CROP_MODE, MAX_CONCURRENCY, NUM_WORKERS, MODEL_PATH, VLLM_TORCH_DTYPE
from deepseek_ocr import DeepseekOCRForCausalLM
from process.image_process import DeepseekOCRProcessor
from vllm import LLM, SamplingParams
from vllm.model_executor.models.registry import ModelRegistry

# Register the custom model
ModelRegistry.register_model("DeepseekOCRForCausalLM", DeepseekOCRForCausalLM)

# Initialize FastAPI app
app = FastAPI(
    title="DeepSeek-OCR API",
    description="High-performance OCR service using DeepSeek-OCR with vLLM",
    version="1.0.0"
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global variables for the model
llm = None
sampling_params = None

def get_sampling_params(
        temperature: Optional[float] = None,
        top_p: Optional[float] = None,
        max_tokens: Optional[int] = None,
) -> SamplingParams:
    """
    Build SamplingParams for this request, overriding selected fields from the
    global sampling_params while keeping all other settings identical.
    """
    global sampling_params

    # Ensure base is initialized
    if sampling_params is None:
        initialize_model()

    base = sampling_params

    # Use overrides if provided, else fall back to base
    temp = base.temperature if temperature is None else float(temperature)
    tp = base.top_p if top_p is None else float(top_p)
    mt = base.max_tokens if max_tokens is None else int(max_tokens)

    # Clamp to safe ranges
    temp = max(0.0, min(2.0, temp))
    tp = max(0.0, min(1.0, tp))
    mt = max(1, min(8192, mt))

    # If nothing changed, reuse base object
    if (
            temp == base.temperature and
            tp == base.top_p and
            mt == base.max_tokens
    ):
        return base

    # Otherwise create a new SamplingParams with same extras as base
    return SamplingParams(
        temperature=temp,
        top_p=tp,
        max_tokens=mt,
        skip_special_tokens=base.skip_special_tokens,
        include_stop_str_in_output=base.include_stop_str_in_output,
        stop=base.stop,
        logits_processors=base.logits_processors,
    )

class OCRResponse(BaseModel):
    success: bool
    result: Optional[str] = None
    error: Optional[str] = None
    page_count: Optional[int] = None

class BatchOCRResponse(BaseModel):
    success: bool
    results: List[OCRResponse]
    total_pages: int
    filename: str

def initialize_model():
    """Initialize the vLLM model"""
    global llm, sampling_params

    if llm is None:
        print("Initializing DeepSeek-OCR model...")
        print(f"Model path from config: {MODEL_PATH}")

        # Get environment variable overrides
        model_path = os.environ.get('MODEL_PATH', MODEL_PATH)
        print(f"Final model path: {model_path}")

        # Set up model download directory if specified
        hf_home = os.environ.get('HF_HOME', '/app/models')
        os.environ['HF_HOME'] = hf_home
        os.environ['TRANSFORMERS_CACHE'] = hf_home
        os.environ['HUGGINGFACE_HUB_CACHE'] = hf_home
        print(f"Model cache directory: {hf_home}")

        dtype = os.environ.get('VLLM_TORCH_DTYPE', VLLM_TORCH_DTYPE)
        print(f"dtype: {dtype}")

        # Initialize vLLM engine with the Hugging Face repository ID
        llm = LLM(
            model=model_path,  # Use HF repository ID: "deepseek-ai/DeepSeek-OCR"
            hf_overrides={"architectures": ["DeepseekOCRForCausalLM"]},
            enforce_eager=True,
            trust_remote_code=True,
            max_model_len=8192,
            swap_space=0,
            max_num_seqs=MAX_CONCURRENCY,
            tensor_parallel_size=1,
            gpu_memory_utilization=0.9,
            disable_mm_preprocessor_cache=True,
            download_dir=hf_home,  # Specify where to download and cache the model
            dtype=dtype,  # Use float16 for Tesla T4 and similar GPUs
        )

        # Set up sampling parameters
        from process.ngram_norepeat import NoRepeatNGramLogitsProcessor
        logits_processors = [NoRepeatNGramLogitsProcessor(ngram_size=30, window_size=90, whitelist_token_ids={128821, 128822})]

        sampling_params = SamplingParams(
            temperature=0.1,
            top_p=0.95,
            max_tokens=1500,
            logits_processors=logits_processors,
            skip_special_tokens=False,
            include_stop_str_in_output=True,
        )

        print("Model initialization complete!")

def pdf_to_images_high_quality(pdf_data: bytes, dpi: int = 144) -> List[Image.Image]:
    """Convert PDF bytes to high-quality PIL Images"""
    images = []

    # Save PDF data to temporary file
    with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as temp_pdf:
        temp_pdf.write(pdf_data)
        temp_pdf_path = temp_pdf.name

    try:
        pdf_document = fitz.open(temp_pdf_path)
        zoom = dpi / 72.0
        matrix = fitz.Matrix(zoom, zoom)

        for page_num in range(pdf_document.page_count):
            page = pdf_document[page_num]
            pixmap = page.get_pixmap(matrix=matrix, alpha=False)

            # Convert to PIL Image
            img_data = pixmap.tobytes("png")
            img = Image.open(io.BytesIO(img_data))
            images.append(img)

        pdf_document.close()
    finally:
        # Clean up temporary file
        os.unlink(temp_pdf_path)

    return images

def process_single_image(
    image: Image.Image,
    prompt: str = PROMPT,
    temperature: Optional[float] = None,
    top_p: Optional[float] = None,
    max_tokens: Optional[int] = None,
) -> str:
    """Process a single image with DeepSeek-OCR using the specified prompt"""
    print(f"[DEBUG] process_single_image called with prompt: {repr(prompt)}")
    print(f"[DEBUG] Prompt length: {len(prompt)} characters")
    print(f"[DEBUG] Prompt starts with <image>: {prompt.startswith('<image>')}")

    # Create request format for vLLM
    request_item = {
        "prompt": prompt,
        "multi_modal_data": {
            "image": DeepseekOCRProcessor().tokenize_with_images(
                prompt=prompt,
                images=[image],
                bos=True,
                eos=True,
                cropping=CROP_MODE
            )
        }
    }

    print(f"[DEBUG] Request item prompt: {repr(request_item['prompt'])}")
    print(f"[DEBUG] Request item keys: {list(request_item.keys())}")
    print(f"[DEBUG] Multi-modal data type: {type(request_item['multi_modal_data'])}")

    # Generate with vLLM
    print(f"[DEBUG] Sending request to vLLM...")
    sp = get_sampling_params(temperature=temperature, top_p=top_p, max_tokens=max_tokens)
    outputs = llm.generate([request_item], sampling_params=sp)
    if not outputs or not outputs[0].outputs:
        raise RuntimeError("No output generated from model")

    result = outputs[0].outputs[0].text
    print(f"[DEBUG] Model output (first 100 chars): {repr(result[:100])}")
    print(f"[DEBUG] Model output length: {len(result)} characters")

    # Clean up result
    if '<ï½œendâ–ofâ–sentenceï½œ>' in result:
        result = result.replace('<ï½œendâ–ofâ–sentenceï½œ>', '')
        print(f"[DEBUG] Removed end-of-sentence tokens")

    return result

@app.on_event("startup")
async def startup_event():
    """Initialize the model on startup"""
    initialize_model()

@app.get("/")
async def root():
    """Health check endpoint"""
    return {"message": "DeepSeek-OCR API is running", "status": "healthy"}

@app.get("/health")
async def health_check():
    """Detailed health check"""
    return {
        "status": "healthy",
        "model_loaded": llm is not None,
        "model_path": os.environ.get('MODEL_PATH', MODEL_PATH),
        "cuda_available": torch.cuda.is_available(),
        "cuda_device_count": torch.cuda.device_count() if torch.cuda.is_available() else 0
    }

@app.post("/ocr/image", response_model=OCRResponse)
async def process_image_endpoint(
    file: UploadFile = File(...),
    prompt: Optional[str] = Form('<image>'),
    temperature: Optional[float] = Form(None),
    top_p: Optional[float] = Form(None),
    max_tokens: Optional[int] = Form(None),
):
    """Process a single image file with optional custom prompt"""
    try:
        print(f"[DEBUG] Image endpoint called for file: {file.filename}")

        # Read image data
        image_data = await file.read()
        print(f"[DEBUG] Read {len(image_data)} bytes of image data")

        # Convert to PIL Image
        image = Image.open(io.BytesIO(image_data)).convert('RGB')
        print(f"[DEBUG] Converted to PIL Image, size: {image.size}")

        # Debug logging
        print(f"[DEBUG] Received prompt parameter: {repr(prompt)}")
        print(f"[DEBUG] Default PROMPT from config: {repr(PROMPT)}")
        print(f"[API] Sampling overrides: temperature={temperature}, top_p={top_p}, max_tokens={max_tokens}")

        # Use provided prompt or default
        use_prompt = prompt if prompt and prompt.strip() else '<image>'
        print(f"[DEBUG] Image endpoint selected prompt: {repr(use_prompt)}")
        print(f"[DEBUG] Using custom prompt: {prompt is not None}")

        # Process with DeepSeek-OCR
        print(f"[DEBUG] Sending image to DeepSeek-OCR...")
        result = process_single_image(
            image,
            use_prompt,
            temperature=temperature,
            top_p=top_p,
            max_tokens=max_tokens,
        )
        print(f"[DEBUG] OCR complete, output length: {len(result)}")

        return OCRResponse(
            success=True,
            result=result,
            page_count=1
        )

    except Exception as e:
        print(f"[ERROR] Image endpoint failed: {str(e)}")
        return OCRResponse(
            success=False,
            error=str(e)
        )

@app.post("/ocr/pdf", response_model=BatchOCRResponse)
async def process_pdf_endpoint(
    file: UploadFile = File(...),
    prompt: Optional[str] = Form('<image>'),
    temperature: Optional[float] = Form(None),
    top_p: Optional[float] = Form(None),
    max_tokens: Optional[int] = Form(None),
):
    """Process a PDF file with optional custom prompt"""
    try:
        print(f"[DEBUG] PDF endpoint called for file: {file.filename}")
        print(f"[DEBUG] Received prompt parameter: {repr(prompt)}")
        print(f"[DEBUG] Default PROMPT from config: {repr(PROMPT)}")
        print(f"[API] Sampling overrides: temperature={temperature}, top_p={top_p}, max_tokens={max_tokens}")

       # Read PDF data
        pdf_data = await file.read()
        print(f"[DEBUG] Read {len(pdf_data)} bytes of PDF data")

        # Convert PDF to images
        images = pdf_to_images_high_quality(pdf_data, dpi=144)
        print(f"[DEBUG] Converted PDF to {len(images)} images")

        if not images:
            print(f"[DEBUG] No images extracted from PDF")
            return BatchOCRResponse(
                success=False,
                results=[],
                total_pages=0,
                filename=file.filename
            )

        # Use provided prompt or default
        use_prompt = prompt if prompt else PROMPT
        print(f"[DEBUG] PDF endpoint selected prompt: {repr(use_prompt)}")
        print(f"[DEBUG] Using custom prompt: {prompt is not None}")

        # Process each page
        results = []
        use_prompt = prompt if prompt and prompt.strip() else '<image>'

        results = []
        for page_num, image in enumerate(tqdm(images, desc="Processing pages")):
            try:
                print(f"[API] Processing page {page_num + 1}/{len(images)}")
                result = process_single_image(
                    image,
                    use_prompt,
                    temperature=temperature,
                    top_p=top_p,
                    max_tokens=max_tokens,
                )
                results.append(OCRResponse(
                    success=True,
                    result=result,
                    page_count=page_num + 1
                ))
            except Exception as e:
                print(f"[ERROR] Page {page_num + 1} failed: {str(e)}")
                results.append(OCRResponse(
                    success=False,
                    error=f"Page {page_num + 1} error: {str(e)}",
                    page_count=page_num + 1
                ))

        print(f"[DEBUG] PDF processing complete: {len(results)} pages processed")
        return BatchOCRResponse(
            success=True,
            results=results,
            total_pages=len(images),
            filename=file.filename
        )

    except Exception as e:
        print(f"[ERROR] PDF endpoint failed: {str(e)}")
        return BatchOCRResponse(
            success=False,
            results=[OCRResponse(success=False, error=str(e))],
            total_pages=0,
            filename=file.filename
        )

@app.post("/ocr/batch")
async def process_batch_endpoint(
    files: List[UploadFile] = File(...),
    prompt: Optional[str] = Form('<image>'),
    temperature: Optional[float] = Form(None),
    top_p: Optional[float] = Form(None),
    max_tokens: Optional[int] = Form(None),
):
    """Process multiple files (images and PDFs) with optional custom prompt"""
    results = []

    print(f"[API] Batch endpoint called with {len(files)} files")
    print(f"[API] Prompt parameter: {repr(prompt)}")
    print(f"[API] Sampling overrides: temperature={temperature}, top_p={top_p}, max_tokens={max_tokens}")

    for file in files:
        print(f"[API] Processing file: {file.filename}")

        if file.filename.lower().endswith('.pdf'):
            result = await process_pdf_endpoint(
                file=file,
                prompt=prompt,
                temperature=temperature,
                top_p=top_p,
                max_tokens=max_tokens,
            )
        else:
            result = await process_image_endpoint(
                file=file,
                prompt=prompt,
                temperature=temperature,
                top_p=top_p,
                max_tokens=max_tokens,
            )

        results.append({
            "filename": file.filename,
            "result": result.dict() if hasattr(result, 'dict') else result
        })

    return {
        "success": True,
        "results": results
    }

if __name__ == "__main__":
    print("Starting DeepSeek-OCR API server...")
    uvicorn.run(
        "start_server:app",
        host="0.0.0.0",
        port=8000,
        reload=False,
        workers=1
    )
