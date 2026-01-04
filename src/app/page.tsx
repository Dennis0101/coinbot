export default function Home() {
  return (
    <main style={{ maxWidth: 920, margin: "40px auto", padding: 16, fontFamily: "system-ui" }}>
      <h2>Vercel Crypto Remittance System</h2>
      <p>Vercel(Serverless/Cron) 전용 코인 송금 자동화 예제입니다.</p>

      <h3>핵심 API</h3>
      <ul>
        <li>
          <code>/api/discord/interactions</code> (Discord Interactions)
        </li>
        <li>
          <code>/api/ios/deposit</code> (iOS 단축어 입금 Webhook)
        </li>
        <li>
          <code>/api/payments/webhook</code> (결제 Webhook 예제)
        </li>
        <li>
          <code>/api/quote</code> (시세/김프 캐시 조회)
        </li>
        <li>
          <code>/api/cron/refresh-prices</code> / <code>/api/cron/refresh-inventory</code> (Vercel Cron)
        </li>
        <li>
          <code>/api/health</code>
        </li>
      </ul>

      <p>
        배포/환경변수/DB 스키마 적용/Discord 명령어 등록은 <code>README.md</code>를 참고하세요.
      </p>
    </main>
  );
}
