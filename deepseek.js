import OpenAI from "openai";
import common from '../../lib/common/common.js'
let groupMessages = []
let model_type = 'deepseek-reasoner' //可选deepseek-chat(V3)
const openai = new OpenAI({
        baseURL: 'https://api.deepseek.com',
        apiKey: 'YOUR-API-KEY'
});

export class DeepSeek extends plugin {
    constructor() {
        super({
            name: 'deepseek',
            dsc: 'deepseek',
            event: 'message',
            priority: -2000,
            rule: [
                {
                    reg: '^#chat(.*)$',
                    fnc: 'chat'
                },
                {
                    reg: '^#deepseek结束对话$',
                    fnc: 'reset'
                },
                {
                    reg: '^#deepseek设置上下文长度(.*)$',
                    fnc: 'setMaxLength',
                    permission: 'master'
                },
                {
                    reg: '^#deepseek设置群聊记录长度(.*)$',
                    fnc: 'setHistoryLength',
                    permission: 'master'
                },
                {
                    reg: '^#deepseek设置提示词(.*)$',
                    fnc: 'setPrompt',
                    permission: 'master'
                },
                {
                    reg: '^#deepseek设置温度(.*)$',
                    fnc: 'setTemperature',
                    permission: 'master'
                },
                {
                    reg: '^#deepseek设置思考过程(.*)$',
                    fnc: 'setForwardMsg',
                    permission: 'master'
                }
            ]
        })
    }
    async chat(e) {
        let historyLength = await redis.get('deepseekJS:historyLength') 
        let maxLength = await redis.get('deepseekJS:maxLength')
        let customPrompt = await redis.get('deepseekJS:prompt')
        let temperature = await redis.get('deepseekJS:temperature')
        historyLength = historyLength >= 0 && historyLength <= 20 ? historyLength : 3
        maxLength = maxLength >= 0 && maxLength <= 10 ? maxLength : 3
        temperature = temperature >= 0 && temperature <= 2 ? temperature : 1
        const msg = e.msg.replace('#chat', '')
        let prompt = [{role: "system", content: customPrompt ? customPrompt : `你在一个QQ群里进行对话，群号为${e.group_id}，你需要记住每位用户的用户名和userid。如果你认为你正在对userid说话，则需要带上[CQ:at,qq=userid]。你可以一次at多位用户，但每位用户至多只能at一次。` }]
        let groupChatHistroy = ''
        if (!Array.isArray(groupMessages[e.group_id])) {
            groupMessages[e.group_id] = []
        }
        if (groupMessages[e.group_id].length > 2 * maxLength) {
            groupMessages[e.group_id] = groupMessages[e.group_id].slice(groupMessages[e.group_id].length - 2 * maxLength)
        }
        if (historyLength > 0) {
            groupChatHistroy = await e.bot.pickGroup(e.group_id, true).getChatHistory(0, maxLength)
            prompt[0].content += '以下是群里的近期聊天记录：' + this.formatGroupChatHistory(groupChatHistroy)
        }
        await this.sendChat(
            e,
            [
                ...prompt,
                ...groupMessages[e.group_id]
            ],
            temperature,
            { role: "user", content: `用户名:${e.sender.nickname}，userid:${e.user_id}说：${msg}` }
        )
    }
    async reset(e) {
        groupMessages[e.group_id] = ''
        e.reply('重置对话完毕')
    }
    async sendChat(e, prompt, temperature, msg) {
        let completion
        try {
            completion = await openai.chat.completions.create({
                messages: [
                    ...prompt,
                    msg
                ],
                model: model_type,
                temperature: parseFloat(temperature),
                frequency_penalty: 0.2,
                presence_penalty: 0.2,
                //tools: tools,
                //tool_choice: "auto"
            })
        } catch (error) {
            logger.error(error)
            e.reply('AI对话请求发送失败', true)
            return true
        }
        let originalRetMsg = completion.choices[0].message.content
        let thinking = completion.choices[0].message.reasoning_content
        let forwardMsg = await redis.get('deepseekJS:forwardMsg') 
        if (thinking && forwardMsg > 0) {
            await this.dealMessage(e, thinking)
            if (forwardMsg == 2) {
                thinking = await common.makeForwardMsg(e, ["以下为思考过程：", thinking])
            }
            e.reply(thinking)
            await common.sleep(1000)
        }
        let matches = await this.dealMessage(e, originalRetMsg)
        e.reply(matches, true)
        groupMessages[e.group_id].push(msg)
        groupMessages[e.group_id].push({'role': 'assistant', 'content': completion.choices[0].message.content})

    }
    async dealMessage(e, originalRetMsg) {
        let atRegex = /(at:|@)([a-zA-Z0-9]+)|\[CQ:at,qq=(\d+)\]/g
        let matches = []
        let match
        let lastIndex = 0
        while ((match = atRegex.exec(originalRetMsg)) !== null) {
            if (lastIndex !== match.index) {
                matches.push(originalRetMsg.slice(lastIndex, match.index))
            }
            let userId = match[2] || match[3]
            let nickname = e.group?.pickMember(parseInt(userId)).nickname
            if (nickname != undefined) {
                matches.push(segment.at(userId, nickname))
            }
            lastIndex = atRegex.lastIndex
        }
        if (lastIndex < originalRetMsg.length) {
            matches.push(originalRetMsg.slice(lastIndex))
        }
        return matches
    }
    async setMaxLength(e) {
        let length = e.msg.replace('#deepseek设置上下文长度', '').trim()
        redis.set('deepseekJS:maxLength', length)
        e.reply('设置成功')
    }
    async setHistoryLength(e) {
        let length = e.msg.replace('#deepseek设置群聊记录长度', '').trim()
        redis.set('deepseekJS:historyLength', length)
        e.reply('设置成功')
    }
    async setPrompt(e) {
        let prompt = e.msg.replace('#deepseek设置提示词', '').trim()
        redis.set('deepseekJS:prompt', prompt)
        e.reply('设置成功')
    }
    async setTemperature(e) {
        let temperature = e.msg.replace('#deepseek设置温度', '').trim()
        redis.set('deepseekJS:temperature', temperature)
        e.reply('设置成功')
    }
    async setForwardMsg(e) {
        let forwardMsg = e.msg.replace('#deepseek设置思考过程', '').trim()
        if (forwardMsg === "关闭") {
            redis.set('deepseekJS:forwardMsg', 0)
            e.reply('设置成功，思考过程将不发送')
        } else if (forwardMsg === "开启") {
            redis.set('deepseekJS:forwardMsg', 1)
            e.reply('设置成功，思考过程将直接发送')
        } else if (forwardMsg === "转发") {
            redis.set('deepseekJS:forwardMsg', 2)
            e.reply('设置成功，思考过程将转发发送')
        }
    }
    formatGroupChatHistory(groupChatHistory) {
        const regex = /\[CQ:image(.*?)\]/g
        return groupChatHistory.map((chat, index) => {
            const { sender, raw_message } = chat
            const nickname = sender.nickname || "未知用户"
            const userId = sender.user_id
            return `${index + 1}. 用户名: ${nickname}，userid: ${userId} 说：${raw_message.replace(regex, "[图片]")}\n`
        })
    }
}
