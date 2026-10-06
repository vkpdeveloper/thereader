# 静かなインターネットの作り方

広告もランキングもない、静かな場所をインターネットの中に作りたいと考えて、小さなブログサービスを開発しました。この記事では、その技術構成と設計の考え方をまとめます。

## 技術構成

フロントエンドには軽量なフレームワークを使い、サーバーはエッジで動かしています。データベースは一つだけにして、運用の手間をできるだけ減らしました。

```typescript
export async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  return new Response(`Hello from ${url.pathname}`);
}
```

今後も少しずつ改良していきたいと思います。読んでいただき、ありがとうございました。
