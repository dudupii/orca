import { useState } from 'react'
import { Image, Pressable } from 'react-native'
import { styles } from './mobile-markdown-styles'

type BlockProps = {
  uri: string
  alt: string
  onPress?: () => void
}

/** A standalone markdown image: full width, intrinsic aspect once loaded, tap opens the file. */
export function MarkdownImageView({ uri, alt, onPress }: BlockProps) {
  const [aspect, setAspect] = useState<number | null>(null)
  return (
    <Pressable
      style={styles.markdownImageFrame}
      onPress={onPress}
      disabled={!onPress}
      accessibilityLabel={alt || 'image'}
    >
      <Image
        source={{ uri }}
        style={
          aspect === null ? styles.markdownImageSizing : { width: '100%', aspectRatio: aspect }
        }
        resizeMode="contain"
        onLoad={(event) => {
          const source = event.nativeEvent.source
          if (source.width > 0 && source.height > 0) {
            setAspect(source.width / source.height)
          }
        }}
      />
    </Pressable>
  )
}

type InlineProps = {
  uri: string
  alt: string
}

/** A fixed-size thumbnail for images inline in prose and table cells. */
export function MarkdownInlineImage({ uri, alt }: InlineProps) {
  return (
    <Image
      source={{ uri }}
      style={styles.markdownInlineImage}
      resizeMode="contain"
      accessibilityLabel={alt || 'image'}
    />
  )
}
