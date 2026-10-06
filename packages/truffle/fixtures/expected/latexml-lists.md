# Sparse Attention for Long Documents

## 1 Model

Long documents strain attention: its cost grows with the square of the sequence length, so a model reading a whole book spends most of its compute comparing words that never matter to each other. We restrict each position to a window and a few global tokens, which keeps the cost linear while leaving every position reachable in two steps.

The model uses attention in three different ways:

- In windowed layers, each position attends to the positions around it, as in \[1\].

- Global tokens attend to every position, and every position attends to them:

  - the first token of each section;
  - a learned summary token.

- Decoder layers mask out every position after the current one.

  The mask is applied before the softmax.

Training proceeds in stages:

1. Pretraining on short sequences.
2. Extension to long sequences.

We ask two questions:

1. (a) Does the window size matter?
2. (b) How many global tokens are enough?

Both questions are answered by the ablations, which vary one setting at a time and keep every other choice fixed, so each difference in the results belongs to a single change in the model.

## References

- \[1\] A. Writer. Local attention. 2020.
