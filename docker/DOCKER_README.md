# DeepSeek-OCR vLLM Docker Deployment

This Docker setup provides a complete DeepSeek-OCR service with vLLM backend, ready for production use.

## Prerequisites

### Hardware Requirements
- **NVIDIA GPU** with CUDA 11.8+ support
- **GPU Memory**: Minimum 16GB VRAM (recommended: 40GB+ A100)
- **System RAM**: Minimum 32GB (recommended: 64GB+)
- **Storage**: 50GB+ free space for model and containers

### Software Requirements
- **Docker** 20.10+ with GPU support
- **Docker Compose** 2.0+
- **NVIDIA Container Toolkit** installed
- **CUDA 11.8** compatible drivers

## Quick Start

### 1. Prepare Model Weights

Create a directory for model weights and download the DeepSeek-OCR model:

```bash
mkdir -p models
# Option 1: Using Hugging Face CLI
pip install huggingface_hub
huggingface-cli download deepseek-ai/DeepSeek-OCR --local-dir models/deepseek-ai/DeepSeek-OCR

# Option 2: Using git
git clone https://huggingface.co/deepseek-ai/DeepSeek-OCR models/deepseek-ai/DeepSeek-OCR
```

### 2. Build and Run

### Windows Users

```cmd
REM Build the Docker image
build.bat

REM Start the service
docker-compose up -d

REM Check logs
docker-compose logs -f deepseek-ocr
```

### Linux/macOS Users
 
```bash
# Build the Docker image
docker-compose build

# Start the service
docker-compose up -d

# Check logs
docker-compose logs -f deepseek-ocr
```

### 3. Verify Installation

```bash
# Health check
curl http://localhost:8000/health

# Should return something like:
{
  "status": "healthy",
  "model_loaded": true,
  "model_path": "/app/models/deepseek-ai/DeepSeek-OCR",
  "cuda_available": true,
  "cuda_device_count": 1
}
```

## API Usage

### Endpoints

#### Health Check
```bash
GET http://localhost:8000/health
```

#### Process Single Image
```bash
curl -X POST "http://localhost:8000/ocr/image" \
  -H "accept: application/json" \
  -H "Content-Type: multipart/form-data" \
  -F "file=@your_image.jpg"
```

#### Process PDF
```bash
curl -X POST "http://localhost:8000/ocr/pdf" \
  -H "accept: application/json" \
  -H "Content-Type: multipart/form-data" \
  -F "file=@your_document.pdf"
```

#### Batch Processing
```bash
curl -X POST "http://localhost:8000/ocr/batch" \
  -H "accept: application/json" \
  -H "Content-Type: multipart/form-data" \
  -F "files=@image1.jpg" \
  -F "files=@document.pdf" \
  -F "files=@image2.png"
```

### Response Format

#### Single Image Response
```json
{
  "success": true,
  "result": "# Document Title\n\nThis is the OCR result in markdown format...",
  "page_count": 1
}
```

#### PDF Response
```json
{
  "success": true,
  "results": [
    {
      "success": true,
      "result": "# Page 1 Content\n...",
      "page_count": 1
    },
    {
      "success": true,
      "result": "# Page 2 Content\n...",
      "page_count": 2
    }
  ],
  "total_pages": 2,
  "filename": "document.pdf"
}
```

## Configuration

### Environment Variables

Edit `docker-compose.yml` to adjust these settings:

```yaml
environment:
  - CUDA_VISIBLE_DEVICES=0                    # GPU device to use
  - MODEL_PATH=/app/models/deepseek-ai/DeepSeek-OCR  # Model path
  - MAX_CONCURRENCY=50                         # Max concurrent requests
  - GPU_MEMORY_UTILIZATION=0.85                # GPU memory usage (0.1-1.0)
```

### Performance Tuning

#### For High-Throughput Processing
```yaml
environment:
  - MAX_CONCURRENCY=100
  - GPU_MEMORY_UTILIZATION=0.95
```

#### For Memory-Constrained Systems
```yaml
environment:
  - MAX_CONCURRENCY=10
  - GPU_MEMORY_UTILIZATION=0.7
```

## Advanced Usage

### Custom API Integration

#### Python Client
```python
import requests

class DeepSeekOCRClient:
    def __init__(self, base_url="http://localhost:8000"):
        self.base_url = base_url
    
    def process_image(self, image_path):
        with open(image_path, 'rb') as f:
            response = requests.post(
                f"{self.base_url}/ocr/image",
                files={"file": f}
            )
        return response.json()
    
    def process_pdf(self, pdf_path):
        with open(pdf_path, 'rb') as f:
            response = requests.post(
                f"{self.base_url}/ocr/pdf",
                files={"file": f}
            )
        return response.json()

# Usage
client = DeepSeekOCRClient()
result = client.process_image("document.jpg")
print(result["result"])
```

#### JavaScript Client
```javascript
class DeepSeekOCR {
    constructor(baseUrl = 'http://localhost:8000') {
        this.baseUrl = baseUrl;
    }
    
    async processImage(file) {
        const formData = new FormData();
        formData.append('file', file);
        
        const response = await fetch(`${this.baseUrl}/ocr/image`, {
            method: 'POST',
            body: formData
        });
        
        return await response.json();
    }
    
    async processPDF(file) {
        const formData = new FormData();
        formData.append('file', file);
        
        const response = await fetch(`${this.baseUrl}/ocr/pdf`, {
            method: 'POST',
            body: formData
        });
        
        return await response.json();
    }
}

// Usage in browser
const ocr = new DeepSeekOCR();
document.getElementById('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    const result = await ocr.processImage(file);
    console.log(result.result);
});
```

## Troubleshooting

### Common Issues

#### 1. Out of Memory Errors
```bash
# Reduce concurrency and GPU memory usage
# Edit docker-compose.yml:
environment:
  - MAX_CONCURRENCY=10
  - GPU_MEMORY_UTILIZATION=0.7
```

#### 2. Model Loading Issues
```bash
# Check model directory structure
ls -la models/deepseek-ai/DeepSeek-OCR/

# Verify model files are present
docker-compose exec deepseek-ocr ls -la /app/models/deepseek-ai/DeepSeek-OCR/
```

#### 3. CUDA Errors
```bash
# Check GPU availability
nvidia-smi

# Check Docker GPU support
docker run --rm --gpus all nvidia/cuda:11.8-base-ubuntu20.04 nvidia-smi
```

#### 4. Slow Performance
```bash
# Monitor GPU usage
watch -n 1 nvidia-smi

# Check container logs
docker-compose logs -f deepseek-ocr
```

### Debug Mode

For debugging, you can run the container with additional tools:

```bash
# Run with shell access
docker-compose run --rm deepseek-ocr bash

# Check model loading
python -c "
import sys
sys.path.insert(0, '/app/DeepSeek-OCR-master/DeepSeek-OCR-vllm')
from config import MODEL_PATH
print(f'Model path: {MODEL_PATH}')
print(f'Model exists: {os.path.exists(MODEL_PATH)}')
"
```

## Production Deployment

### Security Considerations

1. **Network Security**: Use reverse proxy (nginx/traefik) with SSL
2. **Authentication**: Add API key authentication
3. **Rate Limiting**: Implement request rate limiting
4. **Input Validation**: Validate file types and sizes

### Monitoring

```bash
# Add monitoring to docker-compose.yml
services:
  deepseek-ocr:
    # ... existing config
    logging:
      driver: "json-file"
      options:
        max-size: "100m"
        max-file: "5"
```

### Scaling

For multiple GPU instances:

```yaml
services:
  deepseek-ocr-1:
    extends:
      file: docker-compose.yml
      service: deepseek-ocr
    environment:
      - CUDA_VISIBLE_DEVICES=0
    ports:
      - "8000:8000"
  
  deepseek-ocr-2:
    extends:
      file: docker-compose.yml
      service: deepseek-ocr
    environment:
      - CUDA_VISIBLE_DEVICES=1
    ports:
      - "8001:8000"
```

## Support

For issues related to:
- **Docker setup**: Check this README first
- **DeepSeek-OCR model**: Refer to the [official repository](https://github.com/deepseek-ai/DeepSeek-OCR)
- **vLLM**: Refer to [vLLM documentation](https://docs.vllm.ai/)

## License

This Docker setup follows the same license as the DeepSeek-OCR project. Please refer to the original project's license file for details.
