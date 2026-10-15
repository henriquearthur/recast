import { describe, expect, test } from "bun:test";
import { createSmtpMailer } from "../src/server/smtp";
import { createTestApp } from "./harness";

const URL_A = "https://www.youtube.com/watch?v=aaaaaaaaaaa";

async function setRecipient(t: ReturnType<typeof createTestApp>, value: string) {
  return t.request("/api/settings/recipient", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value }),
  });
}

describe("delivery by e-mail", () => {
  test("the recipient is a setting changed through the API", async () => {
    const t = createTestApp(undefined, { recipient: null });
    expect(await (await t.request("/api/settings")).json()).not.toHaveProperty("recipient");
    expect((await setRecipient(t, "me@example.com")).status).toBe(200);
    expect(await (await t.request("/api/settings")).json()).toMatchObject({ recipient: "me@example.com" });
  });

  test("sends the whole article as HTML to the recipient, with video and UI links and an identifying subject", async () => {
    const t = createTestApp(undefined, { recipient: null });
    await setRecipient(t, "me@example.com");
    const { id } = await (await t.api.requestVideo(URL_A)).json();
    await t.clock.advance(60_000);
    expect((await t.api.getVideo(id)).state).toBe("completed");

    expect(t.fakes.sent).toHaveLength(1);
    const mail = t.fakes.sent[0]!;
    expect(mail.to).toBe("me@example.com");
    expect(mail.subject).toBe("Fake Channel: Fake video");
    expect(mail.html).toContain(`href="${URL_A}"`);
    expect(mail.html).toContain(`href="http://recast.test/#/videos/${id}"`);
    expect(mail.html).toMatch(/<li[^>]*>fake summary<\/li>/);
    expect(mail.html).toMatch(/<h2[^>]*>Section<\/h2>/);
    expect(mail.html.indexOf("fake summary")).toBeLessThan(mail.html.indexOf("Section"));
  });

  test("opens with what the video is and names the parts of the article", async () => {
    const t = createTestApp();
    t.fakes.publish("aaaaaaaaaaa", { title: "Why the price went up", channel: "Test Channel", duration: 1697, timestamp: Date.UTC(2026, 9, 3, 15) / 1000 });
    t.fakes.deps.transcriber.transcribe = async () => ({ language: "en", segments: [{ startMs: 0, endMs: 1000, text: "hello" }] });
    t.fakes.deps.writer.write = async () => ({
      markdown: "## TL;DR\n- The price went up\n\n## Why it went up [12:34]\nText.\n\n## What to do (1:02:03)\nText.\n\n## Key takeaways\n- Wait",
      usage: { model: "modelo-x", inputTokens: 1, outputTokens: 1, credits: 0 },
    });
    await t.api.requestVideo(URL_A);
    await t.clock.advance(60_000);
    const html = t.fakes.sent[0]!.html;
    // The video, before any text of the article.
    const top = html.slice(0, html.indexOf("TL;DR"));
    for (const fact of ["Why the price went up", "Test Channel", "October 3, 2026", "28 min", "English", "i.ytimg.com/vi/aaaaaaaaaaa/"]) expect(top).toContain(fact);
    // The summary gets its title once, and is not repeated as a section.
    expect(html.match(/TL;DR/g)).toHaveLength(1);
    expect(html).toContain("In this article");
    // Sections link to their moment of the video.
    expect(html).toContain('href="https://www.youtube.com/watch?v=aaaaaaaaaaa&amp;t=754s"');
    expect(html).toContain('href="https://www.youtube.com/watch?v=aaaaaaaaaaa&amp;t=3723s"');
    expect(html).toMatch(/<h2[^>]*>Why it went up <a/);
    expect(html).toContain("modelo-x");
    // The same e-mail can be previewed from the UI.
    const preview = await t.request("/api/videos/1/email");
    expect(preview.headers.get("content-type")).toContain("text/html");
    expect(await preview.text()).toBe(html);
  });

  test("the e-mail is written in the Article language when the interface has it", async () => {
    const t = createTestApp();
    expect((await t.api.putSetting("articleLanguage", "pt-BR")).status).toBe(200);
    t.fakes.publish("aaaaaaaaaaa", { title: "Lesson", channel: "Test Channel", duration: 1697, timestamp: Date.UTC(2026, 9, 3, 15) / 1000 });
    await t.api.requestVideo(URL_A);
    await t.clock.advance(60_000);
    const html = t.fakes.sent[0]!.html;
    expect(html).toContain('<html lang="pt-BR">');
    for (const text of ["Vídeo novo, pronto para ler", "3 de outubro de 2026", "inglês", "Assistir no YouTube"]) expect(html).toContain(text);
    expect(t.fakes.writes[0]!.instructions).toContain("Write the article in Brazilian Portuguese (pt-BR)");
  });

  test("the Article language must be a language code", async () => {
    const t = createTestApp();
    expect((await t.api.putSetting("articleLanguage", "Portuguese please")).status).toBe(400);
    expect((await t.api.putSetting("articleLanguage", "es")).status).toBe(200);
  });

  test("escapes HTML coming from the article", async () => {
    const t = createTestApp();
    t.fakes.deps.writer.write = async () => ({
      markdown: "## Section\nText with **bold**, *italic* and [link](https://example.com?a=1&b=2).\n\n- <script>x</script>\n- Second item\n\n[active](javascript:alert(1)) [data](data:text/html,<script>alert(1)</script>)\n\n<img src=x onerror=alert(1)>",
      usage: { model: "m", inputTokens: 1, outputTokens: 1, credits: 0 },
    });
    await setRecipient(t, "me@example.com");
    await t.api.requestVideo(URL_A);
    await t.clock.advance(60_000);
    const html = t.fakes.sent[0]!.html;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toMatch(/<h2[^>]*>Section<\/h2>\n<p[^>]*>Text with/);
    expect(html).toContain("<em>italic</em>");
    expect(html).toMatch(/<a href="https:\/\/example.com\?a=1&amp;b=2"[^>]*>link<\/a>/);
    expect(html).toMatch(/<li[^>]*>Second item<\/li>/);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
    expect(html).not.toMatch(/href=["\'](?:javascript|data):/i);
  });

  test("without a recipient the delivery fails saying what is missing, and the article stays readable", async () => {
    const t = createTestApp(undefined, { recipient: null });
    const { id } = await (await t.api.requestVideo(URL_A)).json();
    await t.clock.advance(300_000); // delivery goes through all 3 attempts, with backoff
    const video: any = await t.api.getVideo(id);
    expect(video.state).toBe("failed");
    expect(video.stages[3].attempts).toBe(3);
    expect(video.stages[3].status).toBe("failed");
    expect(video.stages[3].error).toContain("Recipient");
    expect(t.fakes.sent).toHaveLength(0);

    const article = await t.request(`/api/videos/${id}/article`);
    expect(article.status).toBe(200);
    expect((await article.json()).markdown).toContain("Fake article");
  });

  test("a mailer failure is shown on the delivery stage and does not hide the article", async () => {
    const t = createTestApp();
    t.fakes.deps.mailer.send = async () => {
      throw new Error("SMTP is down");
    };
    await setRecipient(t, "me@example.com");
    const { id } = await (await t.api.requestVideo(URL_A)).json();
    await t.clock.advance(300_000); // delivery goes through all 3 attempts, with backoff
    const video: any = await t.api.getVideo(id);
    expect(video.stages[3]).toMatchObject({ status: "failed", attempts: 3, error: "SMTP is down" });
    expect((await (await t.request(`/api/videos/${id}/article`)).json()).markdown).toContain("Fake article");
  });

  test("the article is 404 until the article stage is done", async () => {
    const t = createTestApp();
    const { id } = await (await t.api.requestVideo(URL_A)).json();
    expect((await t.request(`/api/videos/${id}/article`)).status).toBe(404);
  });
});

describe("SMTP mailer", () => {
  const ctx = { signal: new AbortController().signal, onProgress() {}, log() {} };
  const message = { to: "a@b.c", subject: "s", html: "<p>x</p>" };

  test("without credentials in the environment, sending fails naming the missing variables", async () => {
    const mailer = createSmtpMailer({});
    const err = await mailer.send(message, ctx).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("RECAST_SMTP_USER");
    expect((err as Error).message).toContain("RECAST_SMTP_PASSWORD");
  });

  test("names only the variable that is missing", async () => {
    const mailer = createSmtpMailer({ RECAST_SMTP_USER: "me@gmail.com" });
    const err = (await mailer.send(message, ctx).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("RECAST_SMTP_PASSWORD");
    expect(err.message).not.toContain("RECAST_SMTP_USER");
  });
});
