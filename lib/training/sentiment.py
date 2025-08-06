import json
import os
import torch
from torch.utils.data import DataLoader, Dataset
from torch.optim import AdamW  # Import from torch.optim instead of transformers
from transformers import AutoTokenizer, AutoModelForSequenceClassification, get_linear_schedule_with_warmup
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, f1_score
from tqdm import tqdm
import logging

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


class TextDataset(Dataset):
    """Custom dataset for text classification"""
    def __init__(self, texts, labels, tokenizer, max_length):
        self.encodings = tokenizer(texts, truncation=True, padding=True, max_length=max_length)
        self.labels = labels

    def __getitem__(self, idx):
        item = {key: torch.tensor(val[idx]) for key, val in self.encodings.items()}
        item['labels'] = torch.tensor(self.labels[idx])
        return item

    def __len__(self):
        return len(self.labels)


def load_data(data_path: str, data_format: str = 'jsonl'):
    """Load data from various formats"""
    texts, labels = [], []

    if data_format == 'jsonl':
        with open(data_path, 'r', encoding='utf-8') as f:
            for line in f:
                try:
                    obj = json.loads(line)
                    texts.append(obj['text'])
                    labels.append(obj['label'])
                except Exception as e:
                    logger.warning(f"Skipping malformed line: {e}")

    elif data_format == 'csv':
        import pandas as pd
        df = pd.read_csv(data_path)
        texts = df['text'].tolist()
        labels = df['label'].tolist()

    return texts, labels


def evaluate_model(model, dataloader, device):
    """Evaluate model on a dataset"""
    model.eval()
    all_preds = []
    all_labels = []
    total_loss = 0

    with torch.no_grad():
        for batch in dataloader:
            input_ids = batch['input_ids'].to(device)
            attention_mask = batch['attention_mask'].to(device)
            labels = batch['labels'].to(device)

            outputs = model(input_ids, attention_mask=attention_mask, labels=labels)
            loss = outputs.loss
            total_loss += loss.item()

            preds = outputs.logits.argmax(dim=-1)
            all_preds.extend(preds.cpu().numpy())
            all_labels.extend(labels.cpu().numpy())

    accuracy = accuracy_score(all_labels, all_preds)
    f1 = f1_score(all_labels, all_preds, average='weighted')
    avg_loss = total_loss / len(dataloader)

    return {'loss': avg_loss, 'accuracy': accuracy, 'f1': f1}


def train(data_path: str, config: dict) -> None:
    """
    Train a BERT/RoBERTa model for text classification

    Args:
        data_path: Path to data file
        config: Dictionary with configuration parameters
    """
    # Set device
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    logger.info(f"Using device: {device}")

    # Load tokenizer - use AutoTokenizer to automatically select the right tokenizer
    tokenizer = AutoTokenizer.from_pretrained(config['model_name'])
    logger.info(f"Loaded tokenizer: {tokenizer.__class__.__name__}")

    # Load data
    texts, labels = load_data(data_path, config.get('data_format', 'jsonl'))
    logger.info(f"Loaded {len(texts)} samples")

    # Convert labels to integers if they're strings
    if isinstance(labels[0], str):
        unique_labels = sorted(set(labels))
        label_to_id = {label: i for i, label in enumerate(unique_labels)}
        labels = [label_to_id[label] for label in labels]

        # Auto-detect and override config
        detected_num_labels = len(unique_labels)
        if config['num_labels'] != detected_num_labels:
            logger.warning(f"Config num_labels={config['num_labels']} but found {detected_num_labels} unique labels")
            logger.warning(f"Overriding num_labels to {detected_num_labels}")
            config['num_labels'] = detected_num_labels
        logger.info(f"Label mapping: {label_to_id}")
    else:
        # Ensure labels are integers
        labels = [int(label) for label in labels]
        unique_labels = sorted(set(labels))  # Define unique_labels here
        logger.info(f"Labels: {set(labels)}")

        # Auto-detect and override config
        detected_num_labels = len(unique_labels)
        if config['num_labels'] != detected_num_labels:
            logger.warning(f"Config num_labels={config['num_labels']} but found {detected_num_labels} unique labels")
            logger.warning(f"Overriding num_labels to {detected_num_labels}")
            config['num_labels'] = detected_num_labels


    # Split data
    texts_train, texts_val, labels_train, labels_val = train_test_split(
        texts, labels, test_size=config.get('val_split', 0.2), random_state=42, stratify=labels
    )

    # Create datasets
    train_dataset = TextDataset(texts_train, labels_train, tokenizer, config.get('max_length', 128))
    val_dataset = TextDataset(texts_val, labels_val, tokenizer, config.get('max_length', 128))

    # Create dataloaders
    train_loader = DataLoader(train_dataset, batch_size=config['batch_size'], shuffle=True)
    val_loader = DataLoader(val_dataset, batch_size=config['batch_size'], shuffle=False)

    # Load model
    model = AutoModelForSequenceClassification.from_pretrained(
        config['model_name'],
        num_labels=config['num_labels']
    ).to(device)

    # Set up optimizer and scheduler
    optimizer = AdamW(model.parameters(), lr=config['learning_rate'], weight_decay=config.get('weight_decay', 0.01))

    total_steps = len(train_loader) * config['epochs']
    scheduler = get_linear_schedule_with_warmup(
        optimizer,
        num_warmup_steps=int(0.1 * total_steps),
        num_training_steps=total_steps
    )

    # Training loop
    best_val_f1 = 0
    patience_counter = 0

    for epoch in range(config['epochs']):
        logger.info(f"\nEpoch {epoch + 1}/{config['epochs']}")

        # Training
        model.train()
        train_loss = 0
        train_pbar = tqdm(train_loader, desc="Training")

        for batch in train_pbar:
            input_ids = batch['input_ids'].to(device)
            attention_mask = batch['attention_mask'].to(device)
            labels = batch['labels'].to(device)

            outputs = model(input_ids, attention_mask=attention_mask, labels=labels)
            loss = outputs.loss

            optimizer.zero_grad()
            loss.backward()

            # Gradient clipping
            torch.nn.utils.clip_grad_norm_(model.parameters(), config.get('max_grad_norm', 1.0))

            optimizer.step()
            scheduler.step()

            train_loss += loss.item()
            train_pbar.set_postfix({'loss': loss.item()})

        avg_train_loss = train_loss / len(train_loader)

        # Validation
        val_metrics = evaluate_model(model, val_loader, device)

        logger.info(f"Train Loss: {avg_train_loss:.4f}")
        logger.info(f"Val Loss: {val_metrics['loss']:.4f}, Accuracy: {val_metrics['accuracy']:.4f}, F1: {val_metrics['f1']:.4f}")

        # Save best model
        if val_metrics['f1'] > best_val_f1:
            best_val_f1 = val_metrics['f1']
            os.makedirs(config['checkpoint_dir'], exist_ok=True)

            model_path = os.path.join(config['checkpoint_dir'], 'best_model.pt')
            torch.save({
                'model_state_dict': model.state_dict(),
                'config': config,
                'best_f1': best_val_f1
            }, model_path)
            logger.info(f"Saved best model with F1: {best_val_f1:.4f}")
            patience_counter = 0
        else:
            patience_counter += 1

        # Early stopping
        if patience_counter >= config.get('patience', 3):
            logger.info(f"Early stopping triggered after {epoch + 1} epochs")
            break

    logger.info("Training completed!")


if __name__ == "__main__":
    import sys

    if len(sys.argv) != 3:
        print("Usage: python train.py <data_path> <config_path>")
        sys.exit(1)

    data_path = sys.argv[1]
    config_path = sys.argv[2]

    # Load configuration
    with open(config_path, 'r') as f:
        config = json.load(f)

    logger.info(f"Starting training with config: {config}")
    logger.info(f"Data path: {data_path}")

    try:
        train(data_path, config)
    except Exception as e:
        logger.error(f"Training failed: {e}")
        sys.exit(1)
