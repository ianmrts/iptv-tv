# Baixar vídeo no Safari do iPhone

Um favorito (bookmarklet) que encontra os vídeos da página aberta e os salva no app Arquivos.

- **MP4 / MOV / WebM diretos**: baixa o arquivo com barra de progresso.
- **HLS (.m3u8)**, o formato da maioria dos players: escolhe a melhor qualidade, baixa as partes e junta num `.mp4`
  (segmentos `.ts` são convertidos com [mux.js](https://github.com/videojs/mux.js); se o site não deixar carregar o script, sai um `.ts`, que abre no VLC).
- **Ao vivo (HLS)**: grava até você tocar em *Parar e salvar*. Serve para os canais do `iptv.m3u` deste repositório.
- **Retomar, como num torrent**: cada parte baixada fica guardada no Safari. Se a conexão cair, o painel continua sozinho de onde parou; você também pode **Pausar** e **Continuar**. Se a página recarregar ou a aba fechar, abra o painel de novo na mesma página e toque em **Continuar** (o download aparece como *incompleto*). Arquivos diretos retomam pelo byte onde pararam (quando o servidor permite); HLS baixa só as partes que faltam. Transmissões ao vivo não têm como retomar.
- **Partes que não baixam**: uma parte com erro é tentada de novo na hora (até 6 vezes, relendo a playlist se o link expirou), sem parar as outras. Se poucas partes falharem sempre, aparece **Salvar sem as partes que falharam** (o vídeo pula esses trechos).
- **Duração certa**: streams com anúncios ou trechos emendados têm saltos no relógio do vídeo; o painel emenda cada trecho no fim do anterior, para o arquivo não ficar com tempo preto ou duração errada.
- Não funciona com DRM (Netflix, Prime, Disney+…) nem com streams criptografados. Vídeos muito longos podem esgotar a memória do iPhone.

## Instalar

1. Abra `index.html` no iPhone e toque em **Copiar código do favorito** (ou copie o conteúdo de `bookmarklet.txt`).
2. No Safari, compartilhar → **Adicionar Favorito**, com o nome *Baixar vídeo*.
3. Favoritos → **Editar** → *Baixar vídeo*: troque o endereço pelo código copiado.

## Usar

Abra a página do vídeo, dê play por alguns segundos, digite *Baixar vídeo* na barra de endereço e toque no favorito.
No painel, toque em **Baixar**. Quando terminar, toque em **Salvar na Galeria** e escolha **Salvar Vídeo** na folha de compartilhar: o vídeo vai para o app Fotos. **Salvar em Arquivos** continua disponível. Arquivos `.ts`, WebM e MKV não entram na galeria e vão direto para Arquivos.

Durante o download o painel pausa o vídeo do site, para sobrar memória. Se mesmo assim a página recarregar no fim (o iOS fecha a aba quando falta memória), escolha uma qualidade menor no seletor.

Se o site bloquear o download pelo navegador (CORS), toque e segure no link azul e escolha **Baixar Arquivo Vinculado**, ou use **Copiar link**.

## Arquivos

- `video-downloader.js`: código-fonte.
- `build.js`: gera `bookmarklet.txt` e `index.html`. Depois de editar o código-fonte, rode `npm install` (uma vez, instala o minificador terser) e `node build.js`.
- `install.template.html`: modelo da página de instalação.
