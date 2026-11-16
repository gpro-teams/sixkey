// TOTP autofill, Stage 1: the finder's scoring (src/inject/otp.ts, TOTP-AUTOFILL §3.1, §3.2). The scoring is a pure function of
// what is read from one box, so it is tested here on those readings; the reading of a real page, the segmented groups, the
// framework setters and the fill are tested in a real browser (test/e2e/autofill-engine.spec.ts, autofill1.spec.ts).
import { describe, expect, it } from "vitest";
import { covered, LEAD, score, THRESHOLD, type Feat } from "../../src/inject/otp";

const box = (f: Partial<Feat> = {}): Feat => ({
  type: "text",
  autocomplete: "",
  inputmode: "",
  pattern: "",
  max: 0,
  ids: "",
  label: "",
  segments: 0,
  urlHint: false,
  alone: false,
  ...f,
});
const qualifies = (f: Partial<Feat>) => score(box(f)).score >= THRESHOLD;

describe("boxes that take an authenticator code (offered at THRESHOLD)", () => {
  it("constants: the threshold and the lead are the design's", () => {
    expect(THRESHOLD).toBe(40);
    expect(LEAD).toBe(20);
  });
  it("the owner's page: a plain text box whose placeholder says TOTP code, among a password field and a remember-me box", () => {
    expect(qualifies({ label: "TOTP code (required after binding)" })).toBe(true);
    expect(qualifies({ label: "TOTP code (required after binding)", ids: "ant-input" })).toBe(true);
  });
  it("autocomplete=one-time-code alone", () => {
    expect(qualifies({ autocomplete: "one-time-code" })).toBe(true);
    expect(qualifies({ autocomplete: "ONE-TIME-CODE" })).toBe(true);
  });
  it("a name token, with a length and a numeric hint", () => {
    expect(qualifies({ ids: "otp", max: 6 })).toBe(true);
    expect(qualifies({ ids: "login_totp_code", max: 6 })).toBe(true);
    expect(qualifies({ ids: "mfaCode", inputmode: "numeric", max: 6 })).toBe(true);
    expect(qualifies({ ids: "otp" })).toBe(false); // a bare name token (25) is not enough
    expect(qualifies({ ids: "code" })).toBe(false); // "code" alone is weak
  });
  it("a verification-code label with a length", () => {
    expect(qualifies({ label: "Verification code", max: 6 })).toBe(true);
    expect(qualifies({ label: "Verification code", max: 6, inputmode: "numeric" })).toBe(true);
    expect(qualifies({ label: "Security code", type: "tel", max: 6 })).toBe(true);
    expect(qualifies({ label: "Verification code" })).toBe(false); // words alone (25) are not enough
  });
  it("authenticator words are worth more than general code words", () => {
    for (const label of [
      "Enter the code from your authenticator app",
      "Two-factor authentication code",
      "2FA code",
      "MFA token",
      "Enter your 2-step verification code",
      "Zwei-Faktor-Code",
      "Code de double authentification",
      "Autenticador",
      "Двухфакторная аутентификация",
    ])
      expect(qualifies({ label }), label).toBe(true);
  });
  it("Chinese words: 验证码, 动态口令, 两步验证, 谷歌验证器, TOTP", () => {
    expect(qualifies({ label: "动态口令" })).toBe(true);
    expect(qualifies({ label: "请输入两步验证码" })).toBe(true);
    expect(qualifies({ label: "谷歌验证器 6 位数字" })).toBe(true);
    expect(qualifies({ label: "请输入身份验证器中的动态码" })).toBe(true);
    expect(qualifies({ label: "TOTP 验证码" })).toBe(true);
    expect(qualifies({ label: "请输入验证码", max: 6, inputmode: "numeric" })).toBe(true);
    expect(qualifies({ label: "驗證碼", max: 6, inputmode: "numeric" })).toBe(true); // traditional
    expect(qualifies({ label: "請輸入動態密碼" })).toBe(true);
  });
  it("other languages: ja, ko, es, pt, it", () => {
    for (const label of [
      "二段階認証コード",
      "認証アプリのコード",
      "일회용 비밀번호",
      "2단계 인증 코드",
      "Código de verificación en dos pasos",
      "Código de autenticação (duas etapas)",
      "Autenticazione a due fattori",
    ])
      expect(qualifies({ label }), label).toBe(true);
    expect(qualifies({ label: "確認コード", max: 6, inputmode: "numeric" })).toBe(true);
    expect(qualifies({ label: "Código de verificación", max: 6, inputmode: "numeric" })).toBe(true);
  });
  it("a group of 6 or 8 one-character boxes", () => {
    expect(qualifies({ segments: 6, label: "Verification code" })).toBe(true);
    expect(qualifies({ segments: 8, autocomplete: "one-time-code" })).toBe(true);
    expect(qualifies({ segments: 6 })).toBe(false); // six small boxes are not a code by themselves
  });
  it("the page's address can tip a borderline box, and a lone candidate gets a little", () => {
    expect(qualifies({ label: "Code", max: 6, inputmode: "numeric", urlHint: true })).toBe(true);
    expect(score(box({ alone: true })).score).toBe(5);
  });
});

describe("boxes that are never offered", () => {
  it("search, e-mail and URL boxes, whatever they say", () => {
    for (const type of ["search", "email", "url"])
      expect(score(box({ type, label: "Verification code", autocomplete: "one-time-code", max: 6 })).veto).toBe(true);
  });
  it("a password field: autocomplete or a name that says so is a veto", () => {
    expect(score(box({ type: "password", autocomplete: "current-password", label: "TOTP code" })).veto).toBe(true);
    expect(score(box({ type: "password", autocomplete: "new-password", label: "2FA" })).veto).toBe(true);
    expect(score(box({ type: "password", ids: "password", label: "Authenticator code or password" })).veto).toBe(true);
    expect(score(box({ type: "password", ids: "user_pwd" })).veto).toBe(true);
    expect(qualifies({ type: "password", ids: "pass", label: "one-time code", max: 6 })).toBe(false);
  });
  it("a password-type box that really is an OTP box (no password words) is still a candidate", () => {
    expect(qualifies({ type: "password", autocomplete: "one-time-code", max: 6 })).toBe(true);
    expect(qualifies({ type: "password", ids: "otp", label: "Authenticator code", max: 6 })).toBe(true);
  });
  it("username, e-mail and name fields (autocomplete)", () => {
    for (const autocomplete of [
      "username",
      "email",
      "name",
      "tel",
      "tel-national",
      "cc-number",
      "cc-csc",
      "postal-code",
    ])
      expect(score(box({ autocomplete, label: "Verification code", max: 6 })).veto, autocomplete).toBe(true);
  });
  it("phone, mobile, card, ZIP, coupon, amount and search names", () => {
    for (const ids of [
      "phone",
      "mobile",
      "tel",
      "zip",
      "postal",
      "card",
      "cvv",
      "cvc",
      "coupon",
      "promo",
      "amount",
      "q",
      "search",
      "query",
      "username",
    ])
      expect(qualifies({ ids, max: 6, inputmode: "numeric", label: "Code" }), ids).toBe(false);
    expect(qualifies({ ids: "cc-csc", max: 3, inputmode: "numeric" })).toBe(false);
    expect(qualifies({ ids: "phoneNumber", type: "tel", max: 11, inputmode: "numeric" })).toBe(false);
  });
  it("labels that say phone number, card number, CVV, search, coupon, ZIP", () => {
    for (const label of [
      "Phone number",
      "Mobile number",
      "Card number",
      "CVV",
      "Search",
      "Search the help centre",
      "Coupon code",
      "ZIP code",
      "手机号",
      "银行卡号",
      "搜索",
      "電話番号",
    ])
      expect(qualifies({ label, max: 6, inputmode: "numeric" }), label).toBe(false);
  });
  it("image captchas, including the Chinese ones that call themselves 验证码", () => {
    for (const label of [
      "Enter the characters you see (captcha)",
      "图形验证码",
      "图片验证码",
      "看不清？换一张",
      "请完成滑块验证",
      "验证码 看不清",
    ])
      expect(score(box({ label, max: 4 })).veto || !qualifies({ label, max: 4 }), label).toBe(true);
    expect(score(box({ ids: "captcha", label: "验证码", max: 6 })).veto).toBe(true);
    expect(score(box({ ids: "imgCaptchaCode", label: "Verification code", max: 6 })).veto).toBe(true);
  });
  it("hidden, checkbox, radio and button inputs", () => {
    for (const type of ["hidden", "checkbox", "radio", "file", "submit", "button", "image", "reset"])
      expect(score(box({ type, autocomplete: "one-time-code" })).veto, type).toBe(true);
  });
});

describe("a code that was sent to the person (SMS, e-mail): a soft negative with a note", () => {
  it("is marked sent and scores 20 lower", () => {
    const plain = score(box({ label: "Verification code", max: 6, inputmode: "numeric" }));
    const sms = score(box({ label: "Verification code sent by SMS", max: 6, inputmode: "numeric" }));
    expect(sms.sent).toBe(true);
    expect(plain.sent).toBe(false);
    expect(plain.score - sms.score).toBe(20);
  });
  it("in the other languages", () => {
    for (const label of [
      "短信验证码",
      "邮箱验证码",
      "簡訊驗證碼",
      "Enter the code we emailed you",
      "Code envoyé par SMS",
      "SMS コード",
    ])
      expect(score(box({ label })).sent, label).toBe(true);
  });
});

describe("covered: the finder's second look at the host (the same rule as core/match.ts coveredBy)", () => {
  it("the domain itself and its subdomains, on label boundaries", () => {
    expect(covered("github.com", "github.com")).toBe(true);
    expect(covered("gist.github.com", "github.com")).toBe(true);
    expect(covered("notgithub.com", "github.com")).toBe(false);
    expect(covered("github.com.attacker.io", "github.com")).toBe(false);
    expect(covered("github.com-login.ru", "github.com")).toBe(false);
    expect(covered("com", "github.com")).toBe(false);
  });
  it("a trailing dot is the same host (app.example.com. is app.example.com)", () => {
    expect(covered("app.fix.test.", "fix.test")).toBe(true);
    expect(covered("fix.test.", "fix.test")).toBe(true);
    expect(covered("notfix.test.", "fix.test")).toBe(false);
    expect(covered("fix.test.evil.", "fix.test")).toBe(false);
  });
  it("IP addresses only equal", () => {
    expect(covered("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(covered("1.127.0.0.1", "127.0.0.1")).toBe(false);
    expect(covered("0.0.1", "0.0.0.1")).toBe(false);
    expect(covered("[::1]", "[::1]")).toBe(true);
  });
});
