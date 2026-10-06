# Pricing a ride with a formula

A city bike share charges a flat unlock fee and a per-minute rate, and the price of a ride of $t$ minutes is a straight line that anyone can sketch on the back of a ticket.

The unlock costs \$1, so a ride of $t$ minutes costs $1 + 0.15\,t$ in total.

Riders who pay \$ $p$ per month for a pass and ride $n$ times pay $p / n$ per ride, and the pass wins once $n$ is large enough.

A receipt filed under C:\\rides\\2024 keeps its backslashes, and a plain sum like \$5 and \$10 stays text.

$$
\text{price}(t) = 1 + 0.15\,t
$$

With a monthly pass the per-minute rate drops to zero for the first thirty minutes, which changes the shape of the line for short rides.
