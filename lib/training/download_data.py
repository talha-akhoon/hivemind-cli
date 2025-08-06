#!/usr/bin/env python3
"""
Data download script for training containers
Downloads and prepares training data from provided URLs
"""

import json
import os
import requests
import logging
from pathlib import Path

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


def download_file(url: str, filepath: str) -> bool:
    """Download a file from URL to local filepath"""
    try:
        logger.info(f"Downloading {url} to {filepath}")
        response = requests.get(url, stream=True)
        response.raise_for_status()

        with open(filepath, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)

        logger.info(f"Successfully downloaded {filepath}")
        return True
    except Exception as e:
        logger.error(f"Failed to download {url}: {e}")
        return False


def combine_jsonl_files(input_files: list, output_file: str) -> None:
    """Combine multiple JSONL files into one"""
    logger.info(f"Combining {len(input_files)} files into {output_file}")

    with open(output_file, 'w') as outf:
        for input_file in input_files:
            if os.path.exists(input_file):
                with open(input_file, 'r') as inf:
                    for line in inf:
                        outf.write(line)
                logger.info(f"Added {input_file} to combined dataset")
            else:
                logger.warning(f"File not found: {input_file}")


def main():
    """Main data download and preparation function"""
    # Load data access configuration
    try:
        with open('/workspace/data_access.json', 'r') as f:
            data_config = json.load(f)
    except Exception as e:
        logger.error(f"Failed to load data access config: {e}")
        return 1

    # Create data directory
    os.makedirs('/data', exist_ok=True)

    # Download files from provided URLs
    downloaded_files = []
    urls = data_config.get('urls', [])

    if not urls:
        logger.warning("No URLs provided in data_access.json, creating mock dataset for testing")
        # Create a simple mock dataset for testing
        mock_data = [
            '{"text": "This is a positive example", "label": 1}\n',
            '{"text": "This is a negative example", "label": 0}\n',
            '{"text": "Another positive case", "label": 1}\n',
            '{"text": "Another negative case", "label": 0}\n'
        ] * 25  # Create 100 samples

        mock_file = "/data/combined.jsonl"
        with open(mock_file, 'w') as f:
            f.writelines(mock_data)
        logger.info(f"Created mock dataset with {len(mock_data)} samples at {mock_file}")
        return 0

    for i, url in enumerate(urls):
        filename = f"dataset_{i}.jsonl"
        filepath = f"/data/{filename}"

        if download_file(url, filepath):
            downloaded_files.append(filepath)

    if not downloaded_files:
        logger.error("No files were successfully downloaded")
        return 1

    # Combine all downloaded files
    combined_file = "/data/combined.jsonl"
    combine_jsonl_files(downloaded_files, combined_file)

    # Validate the combined file has content
    if not os.path.exists(combined_file) or os.path.getsize(combined_file) == 0:
        logger.error("Combined dataset file is empty or missing")
        return 1

    # Clean up individual files (optional, to save space)
    for file in downloaded_files:
        try:
            os.remove(file)
            logger.info(f"Cleaned up {file}")
        except:
            pass

    logger.info("Data download and preparation completed successfully")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
