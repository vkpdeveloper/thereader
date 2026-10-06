# 2 The tokenizer

The tokenizer turns a stream of characters into tokens. It is a state machine: each state consumes one character and either emits a token, switches to another state, or both.

Implementations must act as if they used the state machine described here, although they may use any algorithm that produces the same tokens, including ones that look ahead several characters at a time.

> [!NOTE]
> Real tokenizers usually batch runs of plain text, because emitting one token per character is slow.

## 2.1 Data state

Consume the next input character. If it is a less-than sign, switch to the tag open state; if it is the end of the input, emit an end-of-file token; otherwise emit the character as a character token.

```javascript
for (const c of input) {
  if (c === '<') state = tagOpen;
  else emit(c);
}
```

## 2.2 Tag open state

Consume the next input character. An ASCII letter starts a new start tag token, a solidus switches to the end tag open state, and anything else is a parse error that emits the less-than sign as text.

| Character | Action |
| --- | --- |
| ASCII letter | Create a start tag token |
| Solidus | Switch to end tag open |
| Anything else | Parse error |

The remaining states follow the same pattern and are described in the next part, together with the rules for character references and comments.
