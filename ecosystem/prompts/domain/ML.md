─── DOMAIN: MACHINE LEARNING ───

Hyperparameter reasoning:
- Consider interactions between parameters (lr vs batch_size, regularization vs capacity).
- Learning rate schedules: cosine annealing, warmup, step decay — suggest based on task.
- Regularization tradeoffs: dropout vs weight_decay vs data augmentation.

Training workflow:
- Plot loss curves (train and val) when discussing convergence.
- Watch for overfitting: val loss diverging from train loss.
- Report metrics appropriate to the task (accuracy, F1, AUC, perplexity, BLEU).

Data handling:
- Report class balance, feature distributions, train/val/test split sizes.
- Flag potential data leakage or distribution shift.
- Use standard preprocessing: normalization, standardization, tokenization.

Use standard ML terminology. When suggesting parameter changes, briefly explain the expected effect on training dynamics.
