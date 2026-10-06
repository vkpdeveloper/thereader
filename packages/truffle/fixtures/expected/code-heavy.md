# Parsing JSON in Rust, Go and Python

Every language has a favourite way to turn bytes into structured data. Here is the same small task, decoding a user record, written three ways, with the trade-offs each one makes explicit.

## Rust

Serde derives the decoder at compile time, so mistakes in field names are compile errors rather than runtime surprises.

```rust
use serde::Deserialize;

#[derive(Deserialize, Debug)]
struct User {
    name: String,
    age: u32,
}

fn main() {
    let user: User = serde_json::from_str(r#"{"name":"Ann","age":41}"#).unwrap();
    println!("{:?}", user);
}
```

## Go

Go uses struct tags and reflection. It is less strict than Serde, but the standard library is all you need and it compiles in a second.

```go
package main

import (
	"encoding/json"
	"fmt"
)

type User struct {
	Name string `json:"name"`
	Age  int    `json:"age"`
}

func main() {
	var u User
	if err := json.Unmarshal([]byte(`{"name":"Ann","age":41}`), &u); err != nil {
		panic(err)
	}
	fmt.Println(u.Name)
}
```

## Python

Python needs no declarations at all; the price is that nothing checks the shape until you touch it, which is why dataclasses and pydantic exist.

```python
import json
from dataclasses import dataclass

data = json.loads('{"name": "Ann", "age": 41}')
print(data["name"])
```

Unlabelled snippets are detected from their content. This one has no class at all:

```python
def greet(name: str) -> str:
    return f"Hello, {name}!"

if __name__ == "__main__":
    print(greet("world"))
```

And a shell session with a prompt, plus a GitHub-style line table:

```shell
$ cargo add serde --features derive
$ cargo run
```

```javascript
const user = JSON.parse(text);
console.log(user.name);
```

Inline code like `json.loads` and keys like `Ctrl`+`C` stay inline.

```toml title="config.toml"
[package]
name = "demo"
version = "0.1.0"
```
