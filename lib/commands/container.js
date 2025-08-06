const fs = require('fs');
const tar = require('tar-stream');
const path = require('path');

// Utility function to convert Docker streams to strings
function streamToPromise(stream) {
    return new Promise((resolve, reject) => {
        let data = '';

        // Docker streams are multiplexed and need demultiplexing
        stream.on('data', chunk => {
            // Docker multiplexed streams have 8-byte headers
            // Skip the first 8 bytes if this looks like a multiplexed stream
            if (chunk.length >= 8 && chunk[0] <= 2 && chunk[1] === 0 && chunk[2] === 0 && chunk[3] === 0) {
                // This is a multiplexed stream, skip the 8-byte header
                const payload = chunk.slice(8);
                data += payload.toString('utf8');
            } else {
                // Regular stream
                data += chunk.toString('utf8');
            }
        });

        stream.on('end', () => {
            // Clean up any remaining control characters
            const cleanData = data.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
            resolve(cleanData);
        });

        stream.on('error', reject);
    });
}

async function createTrainingContainer(bounty, accessData, options = {}) {
    // Detect platform capabilities
    const platformInfo = await detectPlatform();

    // Merge default options with user-provided options
    const config = {
        runtime: options.runtime || 'docker',
        maxMemoryRatio: options.maxMemoryRatio || 0.75, // Use 75% of available memory
        cpuLimit: options.cpuLimit || null, // null = use all available
        gpuEnabled: options.gpuEnabled !== false, // default true
        customImage: options.customImage || null,
        extraDependencies: options.extraDependencies || [],
        volumeMounts: options.volumeMounts || {},
        environment: options.environment || {},
        ...options
    };

    // Select appropriate base image
    const baseImage = config.customImage || selectBaseImage(platformInfo);

    // Calculate resource limits based on platform
    const resources = calculateResourceLimits(platformInfo, config);

    // Create training configuration with platform-aware defaults
    const trainingConfig = {
        template: bounty.template,

        model_name: bounty.hyperparameters?.model_name || selectDefaultModel(resources),
        num_labels: bounty.hyperparameters?.num_labels || 2,
        batch_size: bounty.hyperparameters?.batch_size || calculateOptimalBatchSize(resources, bounty),
        learning_rate: bounty.hyperparameters?.learning_rate || 2e-5,
        epochs: bounty.hyperparameters?.epochs || 3, // Reduced from 5 to 3
        max_length: 64, // Add shorter sequence length to save memory
        checkpoint_dir: '/output',
        mixed_precision: resources.gpu && resources.gpuMemory < 8192, // Auto-enable for low GPU memory
        gradient_checkpointing: true, // Always enable to save memory
        ...bounty.hyperparameters
    };

    // Create tar stream with all necessary files
    const pack = await createTrainingArchive(trainingConfig, accessData, platformInfo);

    // Container configuration
    console.log('Selected base image:', baseImage); // Debug log for image name
    const containerConfig = {
        Image: baseImage,
        Cmd: ['tail', '-f', '/dev/null'], // Keep container running
        WorkingDir: '/workspace',
        HostConfig: buildHostConfig(resources, config, platformInfo),
        Env: buildEnvironment(bounty, config, platformInfo)
    };

    // Create container using appropriate runtime
    const container = await createContainerWithRuntime(config.runtime, containerConfig);
    console.log('Selected container:', container.id); // Debug log for container ID

    // Copy files to container
    await container.putArchive(pack, { path: '/workspace' });
    console.log('Training archive uploaded to container');

    // Start the container before executing commands
    await container.start();
    console.log('Container started successfully');

    // Install dependencies with retry logic
    await installDependencies(container, trainingConfig, config.extraDependencies);
    console.log('Dependencies installed successfully');
    return container;
}

// Platform detection
async function detectPlatform() {
    const os = require('os');
    const { execSync } = require('child_process');

    const platform = {
        arch: process.arch,
        platform: process.platform,
        totalMemory: os.totalmem(),
        cpuCount: os.cpus().length,
        isJetson: false,
        isRaspberryPi: false,
        hasGPU: false,
        gpuInfo: null,
        cudaVersion: null,
        containerRuntime: 'docker'
    };

    // Detect Jetson
    if (platform.arch === 'arm64' && fs.existsSync('/etc/nv_tegra_release')) {
        platform.isJetson = true;
        platform.hasGPU = true;
        try {
            const tegra = fs.readFileSync('/etc/nv_tegra_release', 'utf8');
            platform.jetsonModel = tegra.match(/BOARDID=(\d+)/)?.[1];
        } catch (e) {}
    }

    // Detect Raspberry Pi
    try {
        const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
        platform.isRaspberryPi = cpuinfo.includes('Raspberry Pi');
    } catch (e) {}

    // Detect GPU (NVIDIA)
    try {
        const nvidiaInfo = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader',
            { encoding: 'utf8' });
        if (nvidiaInfo) {
            platform.hasGPU = true;
            const [name, memory] = nvidiaInfo.trim().split(',');
            platform.gpuInfo = { name: name.trim(), memory: parseInt(memory) };
        }
    } catch (e) {}

    // Detect CUDA version
    try {
        const nvcc = execSync('nvcc --version', { encoding: 'utf8' });
        platform.cudaVersion = nvcc.match(/release (\d+\.\d+)/)?.[1];
    } catch (e) {}

    // Check container runtime
    try {
        execSync('podman --version', { encoding: 'utf8' });
        platform.containerRuntime = 'podman';
    } catch (e) {
        try {
            execSync('docker --version', { encoding: 'utf8' });
            platform.containerRuntime = 'docker';
        } catch (e) {}
    }
    console.log(`Detected platform: ${platform.platform} (${platform.arch})`);
    return platform;
}

// Image selection logic
function selectBaseImage(platform) {
    const imageMap = {
        // Jetson specific images
        jetson: {
            '35': 'nvcr.io/nvidia/l4t-pytorch:r35.2.1-pth2.0-py3',
            '32': 'nvcr.io/nvidia/l4t-pytorch:r32.7.1-pth1.10-py3'
        },
        // Architecture specific
        arm64: {
            cpu: 'arm64v8/python:3.9-slim',
            gpu: 'nvcr.io/nvidia/l4t-pytorch:latest'
        },
        x64: {
            cpu: 'python:3.9-slim',
            gpu: {
                '11.7': 'pytorch/pytorch:2.0.0-cuda11.7-cudnn8-runtime',
                '11.8': 'pytorch/pytorch:2.0.0-cuda11.8-cudnn8-runtime',
                '12.1': 'pytorch/pytorch:2.1.0-cuda12.1-cudnn8-runtime'
            }
        }
    };

    if (platform.isJetson) {
        const jetsonVersion = platform.jetsonModel?.substring(0, 2) || '35';
        return imageMap.jetson[jetsonVersion] || imageMap.jetson['35'];
    }

    const archImages = imageMap[platform.arch === 'aarch64' ? 'arm64' : 'x64'];

    if (!platform.hasGPU) {
        return archImages.cpu;
    }

    if (platform.arch === 'x64' && platform.cudaVersion) {
        return archImages.gpu[platform.cudaVersion] || archImages.gpu['11.7'];
    }

    return archImages.gpu;
}

// Resource calculation
function calculateResourceLimits(platform, config) {
    const limits = {
        memory: Math.floor(platform.totalMemory * config.maxMemoryRatio),
        cpuCount: config.cpuLimit || platform.cpuCount,
        gpu: platform.hasGPU && config.gpuEnabled,
        gpuMemory: platform.gpuInfo?.memory || 0,
        totalMemory: platform.totalMemory
    };

    // Platform-specific adjustments
    if (platform.isJetson) {
        limits.memory = Math.min(limits.memory, 6 * 1024 * 1024 * 1024); // Max 6GB
        limits.sharedGPUMemory = true; // Jetson uses shared memory
    }

    if (platform.isRaspberryPi) {
        limits.memory = Math.min(limits.memory, 3 * 1024 * 1024 * 1024); // Max 3GB
        limits.cpuCount = Math.min(limits.cpuCount, 2); // Limit CPU cores
    }

    return limits;
}

// Optimal batch size calculation
function calculateOptimalBatchSize(resources, bounty) {
    const modelSize = getModelSize(bounty.hyperparameters?.model_name);
    const availableMemory = resources.gpu ? resources.gpuMemory : resources.memory;

    // Much more conservative memory estimation for containers
    const memoryPerSample = modelSize * 4; // Increased from 2MB to 4MB per sample
    const maxBatchSize = Math.floor((availableMemory / 1024) * 0.3 / memoryPerSample); // Reduced from 0.7 to 0.3

    // Return power of 2 for better performance, but much smaller
    const batchSize = Math.pow(2, Math.floor(Math.log2(maxBatchSize)));
    return Math.max(1, Math.min(batchSize, 8)); // Reduced max from 64 to 8
}

// Build host configuration
function buildHostConfig(resources, config, platform) {
    const hostConfig = {
        AutoRemove: false,
        Memory: resources.memory,
        CpuCount: resources.cpuCount,
        Binds: [
            `${process.cwd()}/output:/output`,
            // Mount a cache directory for Hugging Face models to persist downloads
            `${process.cwd()}/.cache:/root/.cache`,
            ...Object.entries(config.volumeMounts).map(([host, container]) => `${host}:${container}`)
        ]
    };

    // GPU configuration
    if (resources.gpu) {
        if (platform.isJetson) {
            hostConfig.Runtime = 'nvidia';
            hostConfig.Devices = ['/dev/nvhost-ctrl', '/dev/nvhost-ctrl-gpu'];
        } else {
            hostConfig.DeviceRequests = [{
                Count: config.gpuCount || -1, // -1 = all GPUs
                Capabilities: [['gpu']],
                Options: config.gpuOptions || {}
            }];
        }
    }

    // Add any custom host config
    return { ...hostConfig, ...config.hostConfig };
}

// Build environment variables
function buildEnvironment(bounty, config, platform) {
    const env = [
        'PYTHONUNBUFFERED=1',
        `BOUNTY_ID=${bounty.id}`,
        `PLATFORM_ARCH=${platform.arch}`,
        `HAS_GPU=${platform.hasGPU}`,
        ...Object.entries(config.environment).map(([k, v]) => `${k}=${v}`)
    ];

    // Platform-specific environment
    if (platform.isJetson) {
        env.push(
            'CUDA_HOME=/usr/local/cuda',
            'LD_LIBRARY_PATH=/usr/local/cuda/lib64:$LD_LIBRARY',
            'OPENBLAS_CORETYPE=ARMV8'
        );
    }

    if (platform.cudaVersion) {
        env.push(`CUDA_VERSION=${platform.cudaVersion}`);
    }

    return env;
}

// Create training archive with platform-aware scripts
async function createTrainingArchive(trainingConfig, accessData, platform) {
    const pack = tar.pack();

    // Add training script
    const trainScript = await fs.promises.readFile(
        path.join(__dirname, `../training/${trainingConfig.template}.py`), 'utf8'
    );
    pack.entry({ name: 'train.py' }, trainScript);

    // Add data download script
    const downloadScript = await fs.promises.readFile(
        path.join(__dirname, '../training/download_data.py'), 'utf8'
    );
    pack.entry({ name: 'download_data.py' }, downloadScript);

    // Add config file
    pack.entry({ name: 'config.json' }, JSON.stringify(trainingConfig, null, 2));

    // Add data access info
    pack.entry({ name: 'data_access.json' }, JSON.stringify({
        urls: accessData.presigned_urls || [],
        format: trainingConfig.data_format || 'jsonl'
    }));

    // Add platform info
    pack.entry({ name: 'platform.json' }, JSON.stringify(platform, null, 2));

    // Add optimized entrypoint script
    pack.entry({ name: 'run.sh' }, generateRunScript(trainingConfig, platform));

    pack.finalize();
    return pack;
}

// Generate platform-optimized run script
function generateRunScript(config, platform) {
    return `#!/bin/bash
set -e

# Platform-specific optimizations
${platform.isJetson ? 'export OPENBLAS_CORETYPE=ARMV8' : ''}
${platform.hasGPU ? 'nvidia-smi || true' : ''}

echo "🖥️  Platform: ${platform.arch} | GPU: ${platform.hasGPU}"

# Memory management for low-memory devices - use fallback if free command not available
if command -v free >/dev/null 2>&1; then
    MEMORY_MB=$(free -m | awk '/^Mem:/{print $2}')
    echo "Memory: $((MEMORY_MB / 1024))GB"
    
    if [ $MEMORY_MB -lt 8192 ]; then
        echo "⚠️  Low memory detected, enabling swap..."
        ${platform.isJetson || platform.isRaspberryPi ? `
        # Create swap file if needed
        if [ ! -f /swapfile ]; then
            fallocate -l 4G /swapfile || dd if=/dev/zero of=/swapfile bs=1G count=4
            chmod 600 /swapfile
            mkswap /swapfile
            swapon /swapfile
        fi` : ''}
        export PYTORCH_CUDA_ALLOC_CONF=max_split_size_mb:512
    fi
else
    echo "Memory info not available"
    # Set conservative memory settings
    export PYTORCH_CUDA_ALLOC_CONF=max_split_size_mb:512
fi

# Ensure all required dependencies are installed
echo "🔧 Checking dependencies..."
python -c "import requests, torch, transformers, sklearn, pandas, tqdm" 2>/dev/null || {
    echo "⚠️  Missing dependencies detected, installing..."
    pip install --no-cache-dir torch transformers scikit-learn pandas tqdm requests protobuf
}

echo "📥 Downloading dataset..."
python download_data.py

echo "🔥 Starting training..."
${config.mixed_precision ? 'export MIXED_PRECISION=1' : ''}
${config.gradient_checkpointing ? 'export GRADIENT_CHECKPOINTING=1' : ''}

# Use appropriate python command
if command -v python3 &> /dev/null; then
    python3 train.py /data/combined.jsonl config.json
else
    python train.py /data/combined.jsonl config.json
fi

echo "✅ Training complete!"
`;
}

// Install dependencies with platform awareness
async function installDependencies(container, trainingConfig, extraDeps) {
    // Read platform.json using exec instead of getArchive
    console.log('Reading platform information from container...');
    const exec = await container.exec({
        Cmd: ['cat', '/workspace/platform.json'],
        AttachStdout: true,
        AttachStderr: true
    });
    console.log('Fetching platform data...');
    const stream = await exec.start();
    console.log('Fetching data...');
    const platformData = await streamToPromise(stream);
    console.log('Platform data received, parsing...', platformData);

    const platform = JSON.parse(platformData);
    console.log('Platform data:', platform);

    let deps = [
        'torch',
        'transformers',
        'scikit-learn',
        'pandas',
        'tqdm',
        'requests',
        'protobuf',  // Add protobuf dependency
        ...extraDeps
    ];

    // Platform-specific dependency versions
    if (platform.isJetson) {
        deps = deps.map(dep => {
            if (dep === 'torch') return 'torch @ https://developer.download.nvidia.com/compute/redist/jp/v502/pytorch/torch-2.0.0+nv23.05-cp38-cp38-linux_aarch64.whl';
            return dep;
        });
    }

    // Install with retry logic
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const exec = await container.exec({
                Cmd: ['pip', 'install', '--no-cache-dir', ...deps],
                AttachStdout: true,
                AttachStderr: true
            });

            const stream = await exec.start();
            await streamToPromise(stream);
            break;
        } catch (error) {
            console.log(`Attempt ${attempt} failed: ${error.message}`);
            if (attempt === 3) throw error;
            await new Promise(r => setTimeout(r, 5000)); // Wait 5s before retry
        }
    }
}

// Model size estimation (MB)
function getModelSize(modelName) {
    const sizes = {
        'bert-base': 440,
        'bert-large': 1340,
        'distilbert': 265,
        'roberta-base': 480,
        'gpt2': 548,
        'gpt2-medium': 1520,
        't5-small': 242,
        't5-base': 890
    };

    const key = Object.keys(sizes).find(k => modelName?.toLowerCase().includes(k));
    return sizes[key] || 440; // Default to BERT-base size
}

// Select appropriate default model based on resources
function selectDefaultModel(resources) {
    const availableMemory = resources.gpu ? resources.gpuMemory : resources.memory / 1024; // MB

    // Use smaller models for limited memory environments
    if (availableMemory < 4096) return 'distilbert-base-uncased';
    if (availableMemory < 8192) return 'distilbert-base-uncased'; // Changed from bert-base to distilbert
    return 'bert-base-uncased'; // Changed from roberta-base to bert-base for better memory efficiency
}

// Container creation with runtime selection
async function createContainerWithRuntime(runtime, config) {
    try {
        switch (runtime) {
            case 'podman': {
                const { Podman } = require('dockerode-podman');
                const podman = new Podman();
                return await podman.createContainer(config);
            }
            case 'docker':
            default: {
                const Docker = require('dockerode');
                const docker = new Docker();
                await docker.pull(config.Image, (err, stream) => {
                    if (err) throw err;
                    docker.modem.followProgress(stream, (err, res) => {
                        if (err) throw err;
                        console.log('Image pulled successfully:', config.Image);
                    });
                })
                return await docker.createContainer(config);
            }
        }
    } catch (err) {
        if (err.code === 'ECONNREFUSED' && err.address && err.address.includes('docker.sock')) {
            throw new Error(
                `Could not connect to Docker daemon at ${err.address}.\n` +
                'Please ensure Docker Desktop is running and the Docker socket path is correct.'
            );
        }
        throw err;
    }
}

module.exports = {
    createTrainingContainer
}