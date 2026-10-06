# Why floating point sums drift

A double stores a sign, an exponent and a significand, and the value it represents is

$$
\text{sign} \times 2^{\text{exponent}} \left(1 + \frac{\text{significand}}{2^{52}}\right)
$$

Adding $x$ and $y$ rounds the exact sum to the nearest representable value, so the error of each step is at most $\epsilon |x + y|$ where $\epsilon = 2^{-53}$.

Summing $n$ numbers one after another lets those errors pile up, which is why a ticket that costs \$5 and a meal at \$10 can add up to 15.000000000000002 in a spreadsheet.

$$
\Bigl| \sum_{i=1}^{n} x_i - \operatorname{fl}\Bigl(\sum_{i=1}^{n} x_i\Bigr) \Bigr| \le (n-1)\,\epsilon \sum_{i=1}^{n} |x_i|
$$

Pairwise summation brings the bound down to a logarithmic factor, and Kahan summation removes most of it for a few extra operations per element.

```python
total = sum(prices)  # $ signs in code stay as they are: $x$
```
