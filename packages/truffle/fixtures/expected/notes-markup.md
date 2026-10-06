# Sliding Windows in Practice

Sliding window attention limits each token to a fixed span of earlier tokens, which keeps memory flat as sequences grow. The idea is old, but it only became popular once long contexts did.[^1]

A reference implementation is available[^2] and runs on a single graphics card, which makes it easy to try the technique on your own data.

Rolling buffers keep the cache at the window size, so a sequence ten times longer than the window costs no more memory than one that just fits. That property matters more than raw speed for most deployments.[^3]

Taken together, these choices make long inputs cheap without changing the model's quality on short ones, which is the trade most teams want when they first reach for a longer context.

[^1]: Early versions appeared in work on sparse transformers. 

[^3]: The buffer is indexed modulo the window size, so old entries are overwritten in place.

[^2]: <https://code.example.org/window>
