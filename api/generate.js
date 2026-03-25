const https = require("https");
const crypto = require("crypto");

function getHmacSHA256(key, msg) { return crypto.createHmac("sha256", key).update(msg).digest(); }
function sha256Hex(msg) { return crypto.createHash("sha256").update(msg).digest("hex"); }

function signV3(secretId, secretKey, service, action, payload) {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().split("T")[0];
  const contentType = "application/json; charset=utf-8";
  const canonicalHeaders = `content-type:${contentType}\nhost:hunyuan.tencentcloudapi.com\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256Hex(payload)}`;
  const algorithm = "TC3-HMAC-SHA256";
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = `${algorithm}\n${timestamp}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;
  const secretDate = getHmacSHA256(`TC3${secretKey}`, date);
  const secretService = getHmacSHA256(secretDate, service);
  const secretSigning = getHmacSHA256(secretService, "tc3_request");
  const signature = getHmacSHA256(secretSigning, stringToSign).toString("hex");
  return {
    authorization: `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    timestamp,
  };
}

function callHunyuan(prompt) {
  return new Promise((resolve, reject) => {
    const secretId = process.env.HUNYUAN_SECRET_ID;
    const secretKey = process.env.HUNYUAN_SECRET_KEY;
    if (!secretId || !secretKey) return reject(new Error("API key not configured"));
    const action = "ChatCompletions";
    const body = JSON.stringify({
      Model: "hunyuan-lite",
      Messages: [
        { Role: "system", Content: "You are a workplace communication expert specializing in leave requests. Generate believable, professional leave excuses. Output ONLY plain text, no markdown." },
        { Role: "user", Content: prompt },
      ],
      Temperature: 0.85, TopP: 0.9, Stream: false,
    });
    const { authorization, timestamp } = signV3(secretId, secretKey, "hunyuan", action, body);
    const req = https.request({
      hostname: "hunyuan.tencentcloudapi.com", path: "/", method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: authorization,
        "X-TC-Action": action, "X-TC-Version": "2023-09-01",
        "X-TC-Timestamp": String(timestamp), "X-TC-Region": "ap-guangzhou",
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.Response?.Choices?.length > 0) resolve(json.Response.Choices[0].Message.Content);
          else if (json.Response?.Error) reject(new Error(json.Response.Error.Message));
          else reject(new Error("API error"));
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function cleanText(str) {
  return str
    .replace(/^#{1,4}\s*.*/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/^\s*[-*]\s*/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*>\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseResponse(text, lang) {
  const result = { formal: "", casual: "", emergency: "" };
  
  if (lang === 'zh') {
    const f = text.match(/【正式版】[：:\s]*([\s\S]*?)(?=【轻松版】|$)/);
    const c = text.match(/【轻松版】[：:\s]*([\s\S]*?)(?=【紧急版】|$)/);
    const e = text.match(/【紧急版】[：:\s]*([\s\S]*?)$/);
    if (f) result.formal = cleanText(f[1]);
    if (c) result.casual = cleanText(c[1]);
    if (e) result.emergency = cleanText(e[1]);
  } else {
    const patterns = [
      { f: /\[Formal\][：:\s]*([\s\S]*?)(?=\[Casual\]|\[Urgent\]|$)/i, c: /\[Casual\][：:\s]*([\s\S]*?)(?=\[Urgent\]|$)/i, e: /\[Urgent\][：:\s]*([\s\S]*?)$/i },
      { f: /\*?\*?Formal\*?\*?[：:\s]*([\s\S]*?)(?=\*?\*?Casual)/i, c: /\*?\*?Casual\*?\*?[：:\s]*([\s\S]*?)(?=\*?\*?Urgent)/i, e: /\*?\*?Urgent\*?\*?[：:\s]*([\s\S]*?)$/i },
    ];
    for (const pat of patterns) {
      const fm = text.match(pat.f), cm = text.match(pat.c), em = text.match(pat.e);
      if (fm && cm && em) {
        result.formal = cleanText(fm[1]);
        result.casual = cleanText(cm[1]);
        result.emergency = cleanText(em[1]);
        break;
      }
    }
  }

  if (!result.formal && !result.casual && !result.emergency) {
    const paragraphs = text.split(/\n\s*\n/).map(p => cleanText(p)).filter(p => p.length > 10);
    if (paragraphs.length >= 3) {
      result.formal = paragraphs[0];
      result.casual = paragraphs[1];
      result.emergency = paragraphs[2];
    } else {
      result.formal = result.casual = result.emergency = cleanText(text);
    }
  }
  return result;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { leaveType, companyStyle, country, extraInfo, lang } = req.body || {};
  if (!leaveType) {
    return res.status(400).json({ error: lang === 'zh' ? "请选择请假类型" : "Please select leave type" });
  }

  const isZh = lang === 'zh';
  const prompt = isZh
    ? `用户需要请假，请根据以下信息生成3种不同风格的请假理由。

请假类型：${leaveType}
公司风格：${companyStyle || "一般"}
所在国家/地区：${country || "中国"}
${extraInfo ? `补充信息：${extraInfo}` : ""}

请严格按以下格式输出纯文本，不要任何markdown格式：

【正式版】（适合严格公司，措辞规范）
{请假理由，2-4句话，可直接发给领导}

【轻松版】（适合氛围宽松的公司，自然口语化）
{请假理由，2-3句话}

【紧急版】（适合临时突发情况，简短有力）
{请假理由，1-2句话}

要求：
- 理由真实可信，不要太夸张
- 符合所在国家/地区的职场文化
- 不要用"身体不适"这种太笼统的说法，要具体一点
- 可以直接复制发给领导
- 不要任何markdown标记`
    : `Generate 3 leave request messages based on the following information.

Leave type: ${leaveType}
Company culture: ${companyStyle || "standard"}
Country/Region: ${country || "USA"}
${extraInfo ? `Additional info: ${extraInfo}` : ""}

Output ONLY plain text in this format (no markdown, no **, no #):

[Formal] (For strict/formal companies, professional tone)
{Leave request, 2-4 sentences, ready to send}

[Casual] (For relaxed companies, natural conversational tone)
{Leave request, 2-3 sentences}

[Urgent] (For emergency situations, short and direct)
{Leave request, 1-2 sentences}

Requirements:
- Believable and realistic excuses
- Match the workplace culture of the country/region
- Be specific, not vague like "not feeling well"
- Ready to copy and send to manager
- No markdown formatting whatsoever`;

  try {
    const aiText = await callHunyuan(prompt);
    res.status(200).json({ success: true, data: parseResponse(aiText, lang) });
  } catch (err) {
    console.error("Generation failed:", err);
    res.status(500).json({ error: err.message || (isZh ? "生成失败" : "Generation failed") });
  }
};
