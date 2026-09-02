# PawShop 本地后台真实运营手册

本手册只适用于当前真实的本机运营环境。这里没有演示用户、假订单、模拟支付或示例商品。

## 安全边界

- 后台与数据库只监听 `127.0.0.1`，其他设备不能访问。
- 当前真实商品保持 `Draft`，公开前台不连接后台。
- 客户注册、购物车、订单和收款接口仍然关闭。
- 管理员密码、数据库密钥、加密备份和验证记录位于仓库外的私人目录。
- 不把供应商成本、物流内部报价、证件或未来客户资料提交到 GitHub。

## 启动并登录

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
npm --prefix _commerce run setup:local
npm --prefix _commerce run dev
```

打开 `http://127.0.0.1:9000/app`，使用私人目录中 `local-admin.txt` 保存的店主账号登录。不要截图或复制凭证到聊天、GitHub、客服消息中。

## 当前商品验收

后台应当只看到一个未发布商品：

- SKU：`PAW-CSL-NG-001`
- 售价：USD 29.90
- 图片：9 张
- 状态：Draft

每次修改后运行：

```bash
npm --prefix _commerce run catalog:verify
npm --prefix _commerce run foundation:verify
```

任何一项失败时不要发布商品，也不要连接公开前台。

## 真实加密备份与恢复核验

```bash
npm --prefix _commerce run backup:real
npm --prefix _commerce run restore:verify-real
```

第一条命令从正在使用的 `pawshop_dev` 数据库生成经过 HMAC 完整性认证的 AES-256 加密备份；它不会因为以后增加商品、客户、订单或管理员而拒绝备份。商品是否可以发布仍由 `catalog:verify` 独立判断。

第二条命令把备份真实恢复到临时独立数据库，逐表核对关键商品、价格、图片、管理员、客户和订单数据，写入不含明文业务数据的验证记录，然后默认删除临时数据库，避免营业后累积客户隐私副本。仅在排错确有需要时，才可显式设置 `PAWSHOP_KEEP_RESTORE_DB=1` 保留恢复库，并在排错后删除。

备份密钥只会在第一次、且尚无加密备份时生成；如果已有备份但密钥丢失，命令会硬性失败，不会静默生成一把无法解密旧备份的新密钥。密钥与备份在同一台电脑上仍不能替代异地备份；生产上线前必须增加独立设备或受控对象存储副本，并单独保管密钥恢复材料。

## 停止服务

开发后台在终端运行时按 `Control-C` 停止。PostgreSQL 当前不会自动随系统启动；需要停止时使用私人目录中的实际数据目录：

```bash
/opt/homebrew/opt/postgresql@17/bin/pg_ctl \
  -D "$HOME/Documents/PawShop_Private/development/postgres-17" stop
```

停止前先完成真实备份。不要手动删除数据库目录或备份文件。
