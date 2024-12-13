import Debug from 'debug';
import { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { debounce } from 'lodash';
import { useTranslation } from 'react-i18next';
import SplitPane, { Pane } from 'split-pane-react';
import useChatStore from 'stores/useChatStore';
import useToast from 'hooks/useToast';
import useChatService from 'hooks/useChatService';
import useToken from 'hooks/useToken';
import Empty from 'renderer/components/Empty';
import { tempChatId } from 'consts';
import useUsageStore from 'stores/useUsageStore';
import useNav from 'hooks/useNav';
import Header from './Header';
import Messages from './Messages';
import Editor from './Editor';

import './Chat.scss';
import 'split-pane-react/esm/themes/default.css';
import { IChatResponseMessage } from 'intellichat/types';
import { isBlank } from 'utils/validators';
import IChatService from 'intellichat/services/IChatService';
import useChatKnowledgeStore from 'stores/useChatKnowledgeStore';
import useKnowledgeStore from 'stores/useKnowledgeStore';
import CitationDialog from './CitationDialog';
import { ICollectionFile } from 'types/knowledge';
import { extractCitationIds } from 'utils/util';
import INextChatService from 'intellichat/services/INextCharService';
import { on } from 'events';

const debug = Debug('5ire:pages:chat');

export default function Chat() {
  const { t } = useTranslation();
  const id = useParams().id || tempChatId;
  const anchor = useParams().anchor || null;

  const [activeChatId, setActiveChatId] = useState(id);
  if (activeChatId !== id) {
    setActiveChatId(id);
    debug('Set chat id:', id);
  }
  const [sizes, setSizes] = useState(['auto', 200]);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNav();

  const keywords = useChatStore((state) => state.keywords);
  const messages = useChatStore((state) => state.messages);

  const setKeyword = useChatStore((state) => state.setKeyword);
  const fetchMessages = useChatStore((state) => state.fetchMessages);
  const initChat = useChatStore((state) => state.initChat);
  const getChat = useChatStore((state) => state.getChat);
  const updateChat = useChatStore((state) => state.updateChat);
  const setLoading = useChatStore((state) => state.setLoading);

  const [chatService] = useState<INextChatService>(useChatService());

  const { notifyError } = useToast();

  const scrollToBottom = debounce(
    () => {
      if (ref.current) {
        ref.current.scrollTop = ref.current.scrollHeight;
      }
    },
    100,
    { leading: true, maxWait: 300 }
  );

  useEffect(() => {
    if (activeChatId !== tempChatId) {
      getChat(activeChatId);
    } else if (chatService?.isReady()) {
      initChat({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChatId]);

  const debouncedFetchMessages = useMemo(
    () =>
      debounce(
        async (chatId: string, keyword: string) => {
          await fetchMessages({ chatId, keyword });
          debug('Fetch chat messages, chatId:', chatId, ', keyword:', keyword);
        },
        400,
        {
          leading: true,
          maxWait: 2000,
        }
      ),
    [fetchMessages]
  );

  useEffect(() => {
    const loadMessages = async () => {
      const keyword = keywords[activeChatId] || '';
      await debouncedFetchMessages(activeChatId, keyword);
      if (anchor) {
        const anchorDom = document.getElementById(anchor);
        anchorDom?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else {
        scrollToBottom();
      }
    };
    loadMessages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChatId, debouncedFetchMessages, keywords]);

  const sashRender = () => <div className="border-t border-base" />;

  const createMessage = useChatStore((state) => state.createMessage);
  const createChat = useChatStore((state) => state.createChat);
  const { countInput, countOutput } = useToken();
  const updateMessage = useChatStore((state) => state.updateMessage);
  const appendReply = useChatStore((state) => state.appendReply);

  const { moveChatCollections, setChatCollections } =
    useChatKnowledgeStore.getState();

  const onSubmit = useCallback(
    async (prompt: string) => {
      setLoading(true);
      const model = chatService.context.getModel();
      let $chatId = activeChatId;
      if (activeChatId === tempChatId) {
        const $chat = await createChat({
          summary: prompt.substring(0, 50),
        });
        $chatId = $chat.id;
        setActiveChatId($chatId);
        const knowledgeCollections = moveChatCollections(tempChatId, $chatId);
        await setChatCollections($chatId, knowledgeCollections);
      } else {
        await updateChat({
          id: activeChatId,
          summary: prompt.substring(0, 50),
        });
        setKeyword(activeChatId, ''); // clear filter keyword
      }
      let $reply = '';

      // Knowledge Collections
      let knowledgeChunks = [];
      let files: ICollectionFile[] = [];
      let actualPrompt = prompt;
      const chatCollections = await useChatKnowledgeStore
        .getState()
        .listChatCollections($chatId);
      if (chatCollections.length) {
        const knowledgeString = await window.electron.knowledge.search(
          chatCollections.map((c) => c.id),
          prompt
        );
        knowledgeChunks = JSON.parse(knowledgeString);
        useKnowledgeStore.getState().cacheChunks(knowledgeChunks);
        const filesId = [
          ...new Set<string>(knowledgeChunks.map((k: any) => k.fileId)),
        ];
        files = await useKnowledgeStore.getState().getFiles(filesId);
        actualPrompt = `
# Context #
Please read carefully and use the following context information in JSON format to answer questions.
The context format is {"seqNo": number, "id": "id", "file":"fileName", "content": "content"}.
When using context information in your response, output the reference as \`[(<seqNo>)](citation#<id> '<file>')\` strictly after the relevant content.
---------------------------------------------------
For example:
the context information is: {"seqNo": 1, "id": "432939KFD83242", "file":"Fruit Encyclopedia", "content": "apples are one of common fruit"}.
and the question is: "What are some common fruits?".
The answer should be:
"According to the information provided, apples are a common fruit [(1)](citation#432939KFD83242 'Fruit Encyclopedia')."
---------------------------------------------------
Ensure that the context information is accurately referenced, and label it as [(<seqNo>)](citation#<id> '<file>') when a piece of information is actually used.
${JSON.stringify(
  knowledgeChunks.map((k: any, idx: number) => ({
    seqNo: idx + 1,
    file: files.find((f) => f.id === k.fileId)?.name,
    id: k.id,
    content: k.content,
  }))
)}

# Objective #
${prompt}
`;
      }

      const msg = await useChatStore.getState().createMessage({
        prompt,
        reply: '',
        chatId: $chatId,
        model: model.label,
        temperature: chatService.context.getTemperature(),
        maxTokens: chatService.context.getMaxTokens(),
        isActive: 1,
      });

      scrollToBottom();

      const onChatComplete = async (result: IChatResponseMessage) => {
        /**
         * 异常分两种情况，一种是有输出， 但没有正常结束； 一种是没有输出
         * 异常且没有输出，则只更新 isActive 为 0
         */
        if (result.error && isBlank(result.content)) {
          updateMessage({
            id: msg.id,
            isActive: 0,
          });
        } else {
          const inputTokens = result.inputTokens || (await countInput(prompt));
          const outputTokens =
            result.outputTokens || (await countOutput(result.content || ''));
          const citedChunkIds = extractCitationIds(result.content || '');
          const citedChunks = knowledgeChunks.filter((k: any) =>
            citedChunkIds.includes(k.id)
          );
          const citedFileIds = [
            ...new Set(citedChunks.map((k: any) => k.fileId)),
          ];
          const citedFiles = files.filter((f) => citedFileIds.includes(f.id));
          updateMessage({
            id: msg.id,
            reply: result.content,
            inputTokens,
            outputTokens,
            isActive: 0,
            citedFiles: JSON.stringify(citedFiles.map((f) => f.name)),
            citedChunks: JSON.stringify(
              citedChunks.map((k: any, idx: number) => ({
                seqNo: idx + 1,
                content: k.content,
                id: k.id,
              }))
            ),
          });
          useUsageStore.getState().create({
            provider: chatService.provider.name,
            model: model.label,
            inputTokens,
            outputTokens,
          });
          if (result.context) {
            await updateChat({
              id: $chatId,
              context: JSON.stringify(result.context),
            });
          }
        }
        navigate(`/chats/${$chatId}`);
      };
      console.log(chatService);
      chatService.onComplete(onChatComplete);
      chatService.onReading((content: string) => {
        $reply = appendReply(msg.id, content);
        scrollToBottom();
      });
      chatService.onToolCalling((toolName: string) => {
        debug('Tool calling:', toolName);
      });
      chatService.onError((err: any, aborted: boolean) => {
        console.error(err);
        if (!aborted) {
          notifyError(err.message || err);
        }
      });

      await chatService.chat([
        {
          role: 'user',
          content: actualPrompt,
        },
      ]);
      window.electron.ingestEvent([{ app: 'chat' }, { model: model.label }]);
    },
    [
      activeChatId,
      createMessage,
      scrollToBottom,
      createChat,
      updateChat,
      setKeyword,
      countInput,
      countOutput,
      updateMessage,
      navigate,
      appendReply,
      notifyError,
    ]
  );
  return (
    <div id="chat" className="relative h-screen">
      <Header />
      <div className="h-screen -mx-5 mt-10">
        <SplitPane
          split="horizontal"
          sizes={sizes}
          onChange={setSizes}
          performanceMode
          sashRender={sashRender}
        >
          <Pane className="chat-content flex-grow">
            <div id="messages" ref={ref} className="overflow-y-auto h-full">
              {messages.length ? (
                <div className="mx-auto max-w-screen-md px-5">
                  <Messages messages={messages} />
                </div>
              ) : chatService.isReady() ? null : (
                <Empty image="hint" text={t('Notification.APINotReady')} />
              )}
            </div>
          </Pane>
          <Pane minSize={180} maxSize="60%">
            {chatService.isReady() ? (
              <Editor
                onSubmit={onSubmit}
                onAbort={() => {
                  chatService.abort();
                }}
              />
            ) : (
              <div className="flex flex-col justify-center h-3/4 text-center text-sm text-gray-400">
                {id === tempChatId ? '' : t('Notification.APINotReady')}
              </div>
            )}
          </Pane>
        </SplitPane>
      </div>
      <CitationDialog />
    </div>
  );
}
