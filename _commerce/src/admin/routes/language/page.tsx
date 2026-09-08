import { defineRouteConfig } from '@medusajs/admin-sdk'
import { Button, Container, Heading, Text } from '@medusajs/ui'
import { useTranslation } from 'react-i18next'

const LanguagePage = () => {
  const { i18n } = useTranslation()
  const current = i18n.resolvedLanguage || i18n.language

  const changeLanguage = async (language: 'zhCN' | 'en') => {
    await i18n.changeLanguage(language)
  }

  return (
    <Container className="flex flex-col gap-y-6 p-6">
      <div className="flex flex-col gap-y-2">
        <Heading level="h1">后台语言 / Admin Language</Heading>
        <Text className="text-ui-fg-subtle">
          切换 Medusa 管理界面语言；商品标题和描述等业务内容不会被自动翻译。
        </Text>
        <Text className="text-ui-fg-subtle">
          Switch the Medusa interface language. Product titles and descriptions are not translated automatically.
        </Text>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button onClick={() => changeLanguage('zhCN')} variant={current === 'zhCN' ? 'primary' : 'secondary'}>
          简体中文
        </Button>
        <Button onClick={() => changeLanguage('en')} variant={current === 'en' ? 'primary' : 'secondary'}>
          English
        </Button>
      </div>
    </Container>
  )
}

export const config = defineRouteConfig({
  label: '语言 / Language',
  rank: 999,
})

export default LanguagePage
