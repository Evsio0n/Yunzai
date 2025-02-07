import util from "node:util"
import fs from "node:fs/promises"
import lodash from "lodash"
import cfg from "../config/config.js"
import plugin from "./plugin.js"
import schedule from "node-schedule"
import { segment } from "oicq"
import chokidar from "chokidar"
import moment from "moment"
import path from "node:path"
import Runtime from "./runtime.js"
import Handler from "./handler.js"

/** 全局变量 plugin */
global.plugin = plugin
global.segment = segment

/**
 * 加载插件
 */
class PluginsLoader {
  constructor() {
    this.priority = []
    this.handler = {}
    this.task = []
    this.dir = "plugins"

    /** 命令冷却cd */
    this.groupCD = {}
    this.singleCD = {}

    /** 插件监听 */
    this.watcher = {}

    this.msgThrottle = {}

    /** 星铁命令前缀 */
    this.srReg = /^#?(\*|星铁|星轨|穹轨|星穹|崩铁|星穹铁道|崩坏星穹铁道|铁道)+/
  }

  async getPlugins() {
    const files = await fs.readdir(this.dir, { withFileTypes: true })
    const ret = []
    for (const val of files) {
      if (val.isFile()) continue
      const tmp = {
        name: val.name,
        path: `../../${this.dir}/${val.name}`,
      }

      if (await Bot.fsStat(`${this.dir}/${val.name}/index.js`)) {
        tmp.path = `${tmp.path}/index.js`
        ret.push(tmp)
        continue
      }

      const apps = await fs.readdir(`${this.dir}/${val.name}`, { withFileTypes: true })
      for (const app of apps) {
        if (!app.isFile()) continue
        if (!app.name.endsWith(".js")) continue
        ret.push({
          name: `${tmp.name}/${app.name}`,
          path: `${tmp.path}/${app.name}`,
        })
        /** 监听热更新 */
        this.watch(val.name, app.name)
      }
    }
    return ret
  }

  /**
   * 监听事件加载
   * @param isRefresh 是否刷新
   */
  async load(isRefresh = false) {
    if (!lodash.isEmpty(this.priority) && !isRefresh) return

    const files = await this.getPlugins()

    logger.info("-----------")
    logger.info("加载插件中...")

    this.pluginCount = 0
    const packageErr = []

    await Promise.allSettled(files.map(file =>
      this.importPlugin(file, packageErr)
    ))

    this.packageTips(packageErr)
    this.creatTask()

    logger.info(`加载定时任务[${this.task.length}个]`)
    logger.info(`加载插件[${this.pluginCount}个]`)

    /** 优先级排序 */
    this.priority = lodash.orderBy(this.priority, ["priority"], ["asc"])
  }

  async importPlugin(file, packageErr) {
    try {
      let app = await import(file.path)
      if (app.apps) app = { ...app.apps }
      const pluginArray = []
      lodash.forEach(app, p =>
        pluginArray.push(this.loadPlugin(file, p))
      )
      for (const i of await Promise.allSettled(pluginArray))
        if (i?.status && i.status != "fulfilled") {
          logger.error(`加载插件错误：${logger.red(file.name)}`)
          logger.error(decodeURI(i.reason))
        }
    } catch (error) {
      if (packageErr && error.stack.includes("Cannot find package")) {
        packageErr.push({ error, file })
      } else {
        logger.error(`加载插件错误：${logger.red(file.name)}`)
        logger.error(decodeURI(error.stack))
      }
    }
  }

  async loadPlugin(file, p) {
    if (!p?.prototype) return
    this.pluginCount++
    const plugin = new p
    logger.debug(`加载插件 [${file.name}][${plugin.name}]`)
    /** 执行初始化，返回 return 则跳过加载 */
    if (plugin.init && await plugin.init() == "return") return
    /** 初始化定时任务 */
    this.collectTask(plugin.task)
    this.priority.push({
      class: p,
      key: file.name,
      name: plugin.name,
      priority: plugin.priority
    })
    if (plugin.handler) {
      lodash.forEach(plugin.handler, ({ fn, key, priority }) => {
        Handler.add({
          ns: plugin.namespace || file.name,
          key,
          self: plugin,
          property: priority || plugin.priority || 500,
          fn: plugin[fn]
        })
      })
    }
  }

  packageTips(packageErr) {
    if (!packageErr || packageErr.length <= 0) return
    logger.mark("--------插件加载错误--------")
    packageErr.forEach(v => {
      let pack = v.error.stack.match(/'(.+?)'/g)[0].replace(/'/g, "")
      logger.mark(`${v.file.name} 缺少依赖：${logger.red(pack)}`)
      logger.mark(`新增插件后请执行安装命令：${logger.red("pnpm i")} 安装依赖`)
      logger.mark("如安装后仍未解决可联系插件作者解决")
    })
    logger.mark("---------------------")
  }

  /**
   * 处理事件
   *
   * 参数文档 https://github.com/TimeRainStarSky/Yunzai/tree/docs
   * @param e 事件
   */
  async deal(e) {
    this.count(e, "receive", e.message)
    /** 检查黑白名单 */
    if (!this.checkBlack(e)) return
    /** 冷却 */
    if (!this.checkLimit(e)) return
    /** 处理事件 */
    this.dealEvent(e)
    /** 处理回复 */
    this.reply(e)
    /** 过滤事件 */
    let priority = []
    /** 注册runtime */
    await Runtime.init(e)

    this.priority.forEach(v => {
      const p = new v.class(e)
      p.e = e
      /** 判断是否启用功能 */
      if (!this.checkDisable(e, p)) return
      /** 过滤事件 */
      if (!this.filtEvent(e, p)) return
      priority.push(p)
    })

    for (let plugin of priority) {
      /** 上下文hook */
      if (plugin.getContext) {
        let context = plugin.getContext()
        if (!lodash.isEmpty(context)) {
          for (let fnc in context) {
            plugin[fnc](context[fnc])
          }
          return
        }
      }

      /** 群上下文hook */
      if (plugin.getContextGroup) {
        let context = plugin.getContextGroup()
        if (!lodash.isEmpty(context)) {
          for (let fnc in context) {
            plugin[fnc](context[fnc])
          }
          return
        }
      }
    }

    /** 是否只关注主动at */
    if (!this.onlyReplyAt(e)) return

    // 判断是否是星铁命令，若是星铁命令则标准化处理
    // e.isSr = true，且命令标准化为 #星铁 开头
    Object.defineProperty(e, "isSr", {
      get: () => e.game === "sr",
      set: (v) => e.game = v ? "sr" : "gs"
    })
    Object.defineProperty(e, "isGs", {
      get: () => e.game === "gs",
      set: (v) => e.game = v ? "gs" : "sr"
    })
    if (this.srReg.test(e.msg)) {
      e.game = "sr"
      e.msg = e.msg.replace(this.srReg, "#星铁")
    }

    /** 优先执行 accept */
    for (const plugin of priority)
      if (plugin.accept) {
        const res = await plugin.accept(e)
        if (res == "return") return
        if (res) break
      }

    a: for (const plugin of priority) {
      /** 正则匹配 */
      if (plugin.rule) for (const v of plugin.rule) {
        /** 判断事件 */
        if (v.event && !this.filtEvent(e, v)) continue

        if (!new RegExp(v.reg).test(e.msg)) continue
        e.logFnc = `[${plugin.name}][${v.fnc}]`

        if (v.log !== false)
          logger.info(`${e.logFnc}${e.logText} ${lodash.truncate(e.msg, { length: 100 })}`)

        /** 判断权限 */
        if (!this.filtPermission(e, v)) break a

        try {
          const start = Date.now()
          const res = plugin[v.fnc] && (await plugin[v.fnc](e))
          if (res !== false) {
            /** 设置冷却cd */
            this.setLimit(e)
            if (v.log !== false)
              logger.mark(`${e.logFnc} ${lodash.truncate(e.msg, { length: 100 })} 处理完成 ${Date.now() - start}ms`)
            break a
          }
        } catch (error) {
          logger.error(`${e.logFnc}`)
          logger.error(error.stack)
          break a
        }
      }
    }
  }

  /** 过滤事件 */
  filtEvent(e, v) {
    if (!v.event) return false
    let event = v.event.split(".")
    let eventMap = {
      message: ["post_type", "message_type", "sub_type"],
      notice: ["post_type", "notice_type", "sub_type"],
      request: ["post_type", "request_type", "sub_type"]
    }
    let newEvent = []
    event.forEach((val, index) => {
      if (val === "*") {
        newEvent.push(val)
      } else if (eventMap[e.post_type]) {
        newEvent.push(e[eventMap[e.post_type][index]])
      }
    })
    newEvent = newEvent.join(".")

    return v.event === newEvent
  }

  /** 判断权限 */
  filtPermission(e, v) {
    if (v.permission == "all" || !v.permission) return true

    if (v.permission == "master") {
      if (e.isMaster) {
        return true
      } else {
        e.reply("暂无权限，只有主人才能操作")
        return false
      }
    }

    if (e.isGroup) {
      if (!e.member?._info) {
        e.reply("数据加载中，请稍后再试")
        return false
      }
      if (v.permission == "owner") {
        if (!e.member.is_owner) {
          e.reply("暂无权限，只有群主才能操作")
          return false
        }
      }
      if (v.permission == "admin") {
        if (!e.member.is_admin) {
          e.reply("暂无权限，只有管理员才能操作")
          return false
        }
      }
    }

    return true
  }

  dealText(text = "") {
    if (cfg.bot["/→#"])
      text = text.replace(/^\s*\/\s*/, "#")
    return text
      .replace(/^\s*[＃井]\s*/, "#")
      .replace(/^\s*[＊※]\s*/, "*")
      .trim()
  }

  /**
   * 处理事件，加入自定义字段
   * @param e.msg 文本消息，多行会自动拼接
   * @param e.img 图片消息数组
   * @param e.atBot 是否at机器人
   * @param e.at 是否at，多个at 以最后的为准
   * @param e.file 接受到的文件
   * @param e.isPrivate 是否私聊
   * @param e.isGroup 是否群聊
   * @param e.isMaster 是否管理员
   * @param e.logText 日志用户字符串
   * @param e.logFnc  日志方法字符串
   */
  dealEvent(e) {
    if (e.message) for (const i of e.message) {
      switch (i.type) {
        case "text":
          if (!e.msg) e.msg = ""
          e.msg += this.dealText(i.text)
          break
        case "image":
          if (Array.isArray(e.img))
            e.img.push(i.url)
          else
            e.img = [i.url]
          break
        case "at":
          if (i.qq == e.self_id)
            e.atBot = true
          else
            e.at = i.qq
          break
        case "reply":
          e.reply_id = i.id
          if (e.group?.getMsg)
            e.getReply = () => e.group.getMsg(e.reply_id)
          else if (e.friend?.getMsg)
            e.getReply = () => e.friend.getMsg(e.reply_id)
          break
        case "file":
          e.file = i
          break
      }
    }

    e.logText = ""

    if (e.message_type == "private" || e.notice_type == "friend") {
      e.isPrivate = true

      if (e.sender) {
        e.sender.card = e.sender.nickname
      } else {
        e.sender = {
          user_id: e.user_id,
          nickname: e.friend?.nickname,
          card: e.friend?.nickname,
        }
      }

      e.logText = `[${e.sender?.nickname ? `${e.sender.nickname}(${e.user_id})` : e.user_id}]`
    } else if (e.message_type == "group" || e.notice_type == "group") {
      e.isGroup = true

      if (e.sender) {
        if (!e.sender.card)
          e.sender.card = e.sender.nickname
      } else {
        e.sender = {
          user_id: e.user_id,
          nickname: e.member?.nickname || e.friend?.nickname,
          card: e.member?.card || e.member?.nickname || e.friend?.nickname,
        }
      }

      if (!e.group_name && e.group?.name)
        e.group_name = e.group.name

      e.logText = `[${e.group_name ? `${e.group_name}(${e.group_id})` : e.group_id}, ${e.sender?.card ? `${e.sender.card}(${e.user_id})` : e.user_id}]`
    }

    if (e.user_id && cfg.master[e.self_id]?.includes(String(e.user_id))) {
      e.isMaster = true
    }

    /** 只关注主动at msg处理 */
    if (e.msg && e.isGroup) {
      let groupCfg = cfg.getGroup(e.self_id, e.group_id)
      let alias = groupCfg.botAlias
      if (!Array.isArray(alias)) {
        alias = [alias]
      }
      for (let name of alias) {
        if (e.msg.startsWith(name)) {
          e.msg = lodash.trimStart(e.msg, name).trim()
          e.hasAlias = true
          break
        }
      }
    }
  }

  /** 处理回复,捕获发送失败异常 */
  reply(e) {
    const reply = e.reply ? e.reply.bind(e) : msg => {
      if (e.isGroup) {
        if (e.group?.sendMsg)
          return e.group.sendMsg(msg)
        else
          return e.bot.pickGroup(e.group_id).sendMsg(msg)
      } else {
        if (e.friend?.sendMsg)
          return e.friend.sendMsg(msg)
        else
          return e.bot.pickFriend(e.user_id).sendMsg(msg)
      }
    }

    /**
     * @param msg 发送的消息
     * @param quote 是否引用回复
     * @param data.recallMsg 是否撤回消息，0-120秒，0不撤回
     * @param data.at 是否提及用户
     */
    e.reply = async (msg = "", quote = false, data = {}) => {
      if (!msg) return false

      let { recallMsg = 0, at = "" } = data

      if (at && e.isGroup) {
        if (at === true)
          at = e.user_id
        if (Array.isArray(msg))
          msg.unshift(segment.at(at), "\n")
        else
          msg = [segment.at(at), "\n", msg]
      }

      if (quote && e.message_id) {
        if (Array.isArray(msg))
          msg.unshift(segment.reply(e.message_id))
        else
          msg = [segment.reply(e.message_id), msg]
      }

      let res
      try {
        res = await reply(msg)
      } catch (err) {
        Bot.makeLog("error", ["发送消息错误", msg, err], e.self_id)
      }

      if (recallMsg > 0 && res?.message_id) {
        if (e.group?.recallMsg)
          setTimeout(() => {
            e.group.recallMsg(res.message_id)
            if (e.message_id)
              e.group.recallMsg(e.message_id)
          }, recallMsg * 1000)
        else if (e.friend?.recallMsg)
          setTimeout(() => {
            e.friend.recallMsg(res.message_id)
            if (e.message_id)
              e.friend.recallMsg(e.message_id)
          }, recallMsg * 1000)
      }

      this.count(e, "send", msg)
      return res
    }
  }

  async count(e, type, msg) {
    if (cfg.bot.msg_type_count)
      for (const i of Array.isArray(msg) ? msg : [msg])
        await this.saveCount(e, `${type}:${i?.type || "text"}`)
    await this.saveCount(e, `${type}:msg`)
  }

  async saveCount(e, type) {
    const key = []

    const day = moment().format("YYYY:MM:DD")
    const month = moment().format("YYYY:MM")
    const year = moment().format("YYYY")
    for (const i of [day, month, year, "total"]) {
      key.push(`total:${i}`)
      if (e.self_id) key.push(`bot:${e.self_id}:${i}`)
      if (e.user_id) key.push(`user:${e.user_id}:${i}`)
      if (e.group_id) key.push(`group:${e.group_id}:${i}`)
    }

    for (const i of key)
      await redis.incr(`Yz:count:${type}:${i}`)
  }

  /** 收集定时任务 */
  collectTask(task) {
    if (Array.isArray(task)) {
      task.forEach((val) => {
        if (!val.cron) return
        if (!val.name) throw new Error("插件任务名称错误")
        this.task.push(val)
      })
    } else {
      if (task.fnc && task.cron) {
        if (!task.name) throw new Error("插件任务名称错误")
        this.task.push(task)
      }
    }
  }

  /** 创建定时任务 */
  creatTask() {
    if (process.argv[1].includes("test")) return
    this.task.forEach((val) => {
      val.job = schedule.scheduleJob(val.cron, async () => {
        try {
          if (val.log === true) {
            logger.mark(`开始定时任务：${val.name}`)
          }
          let res = val.fnc()
          if (util.types.isPromise(res)) res = await res
          if (val.log === true) {
            logger.mark(`定时任务完成：${val.name}`)
          }
        } catch (error) {
          logger.error(`定时任务报错：${val.name}`)
          logger.error(error)
        }
      })
    })
  }

  /** 检查命令冷却cd */
  checkLimit(e) {
    /** 禁言中 */
    if (e.isGroup && e.group?.mute_left > 0) return false
    if (!e.message || e.isPrivate) return true

    const config = cfg.getGroup(e.self_id, e.group_id)

    if (config.groupCD && this.groupCD[e.group_id])
      return false

    if (config.singleCD && this.singleCD[`${e.group_id}.${e.user_id}`])
      return false

    const msgId = `${e.self_id}:${e.user_id}:${e.raw_message}`
    if (this.msgThrottle[msgId]) return false

    this.msgThrottle[msgId] = true
    setTimeout(() => delete this.msgThrottle[msgId], 1000)

    return true
  }

  /** 设置冷却cd */
  setLimit(e) {
    if (!e.message || e.isPrivate) return
    let config = cfg.getGroup(e.self_id, e.group_id)

    if (config.groupCD) {
      this.groupCD[e.group_id] = true
      setTimeout(() => delete this.groupCD[e.group_id], config.groupCD)
    }
    if (config.singleCD) {
      const key = `${e.group_id}.${e.user_id}`
      this.singleCD[key] = true
      setTimeout(() => delete this.singleCD[key], config.singleCD)
    }
  }

  /** 是否只关注主动at */
  onlyReplyAt(e) {
    if (!e.message || e.isPrivate) return true

    let groupCfg = cfg.getGroup(e.self_id, e.group_id)

    /** 模式0，未开启前缀 */
    if (groupCfg.onlyReplyAt == 0 || !groupCfg.botAlias) return true

    /** 模式2，非主人开启 */
    if (groupCfg.onlyReplyAt == 2 && e.isMaster) return true

    /** at机器人 */
    if (e.atBot) return true

    /** 消息带前缀 */
    if (e.hasAlias) return true

    return false
  }

  /** 判断黑白名单 */
  checkBlack(e) {
    let other = cfg.getOther()

    if (e.test) return true

    /** 黑名单qq */
    if (other.blackQQ?.length && other.blackQQ.includes(Number(e.user_id) || String(e.user_id))) {
      return false
    }

    if (e.group_id) {
      /** 白名单群 */
      if (other.whiteGroup?.length) {
        if (other.whiteGroup.includes(Number(e.group_id) || String(e.group_id))) return true
        return false
      }
      /** 黑名单群 */
      if (other.blackGroup?.length && other.blackGroup.includes(Number(e.group_id) || String(e.group_id))) {
        return false
      }
    }

    return true
  }

  /** 判断是否启用功能 */
  checkDisable(e, p) {
    let groupCfg = cfg.getGroup(e.self_id, e.group_id)
    if (!lodash.isEmpty(groupCfg.enable)) {
      if (groupCfg.enable.includes(p.name)) {
        return true
      }
      // logger.debug(`${e.logText}[${p.name}]功能已禁用`)
      return false
    }

    if (!lodash.isEmpty(groupCfg.disable)) {
      if (groupCfg.disable.includes(p.name)) {
        // logger.debug(`${e.logText}[${p.name}]功能已禁用`)
        return false
      }

      return true
    }
    return true
  }

  async changePlugin(key) {
    try {
      let app = await import(`../../${this.dir}/${key}?${moment().format("x")}`)
      if (app.apps) app = { ...app.apps }
      lodash.forEach(app, p => {
        const plugin = new p
        for (const i in this.priority)
          if (this.priority[i].key == key && this.priority[i].name == plugin.name) {
            this.priority[i].class = p
            this.priority[i].priority = plugin.priority
          }
      })
      this.priority = lodash.orderBy(this.priority, ["priority"], ["asc"])
    } catch (error) {
      logger.error(`加载插件错误：${logger.red(key)}`)
      logger.error(decodeURI(error.stack))
    }
  }

  /** 监听热更新 */
  watch(dirName, appName) {
    this.watchDir(dirName)
    if (this.watcher[`${dirName}.${appName}`]) return

    const file = `./${this.dir}/${dirName}/${appName}`
    const watcher = chokidar.watch(file)
    const key = `${dirName}/${appName}`

    /** 监听修改 */
    watcher.on("change", path => {
      logger.mark(`[修改插件][${dirName}][${appName}]`)
      this.changePlugin(key)
    })

    /** 监听删除 */
    watcher.on("unlink", async path => {
      logger.mark(`[卸载插件][${dirName}][${appName}]`)
      /** 停止更新监听 */
      this.watcher[`${dirName}.${appName}`].removeAllListeners("change")
      for (const i in this.priority)
        if (this.priority[i].key == key)
          this.priority.splice(i, 1)
    })
    this.watcher[`${dirName}.${appName}`] = watcher
  }

  /** 监听文件夹更新 */
  watchDir(dirName) {
    if (this.watcher[dirName]) return
    const watcher = chokidar.watch(`./${this.dir}/${dirName}/`)
    /** 热更新 */
    Bot.once("online", () => {
      /** 新增文件 */
      watcher.on("add", async PluPath => {
        const appName = path.basename(PluPath)
        if (!appName.endsWith(".js")) return
        logger.mark(`[新增插件][${dirName}][${appName}]`)
        const key = `${dirName}/${appName}`
        await this.importPlugin({
          name: key,
          path: `../../${this.dir}/${key}?${moment().format("X")}`,
        })
        /** 优先级排序 */
        this.priority = lodash.orderBy(this.priority, ["priority"], ["asc"])
        this.watch(dirName, appName)
      })
    })
    this.watcher[dirName] = watcher
  }
}
export default new PluginsLoader()