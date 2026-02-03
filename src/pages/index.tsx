import { useCallback, useContext, useEffect, useState, useRef } from "react";
import VrmViewer from "@/components/vrmViewer";
import { ViewerContext } from "@/features/vrmViewer/viewerContext";
import {
  Message,
  textsToScreenplay,
  Screenplay,
} from "@/features/messages/messages";
import { speakCharacter } from "@/features/messages/speakCharacter";
import { MessageInputContainer } from "@/components/messageInputContainer";
import { SYSTEM_PROMPT } from "@/features/constants/systemPromptConstants";
import { KoeiroParam, DEFAULT_KOEIRO_PARAM } from "@/features/constants/koeiroParam";
import { getChatResponseStream } from "@/features/chat/openAiChat";
import { M_PLUS_2, Montserrat } from "next/font/google";
import { Introduction } from "@/components/introduction";
import { Menu } from "@/components/menu";
import { GitHubLink } from "@/components/githubLink";
import { Meta } from "@/components/meta";
import { ElevenLabsParam, DEFAULT_ELEVEN_LABS_PARAM } from "@/features/constants/elevenLabsParam";
import { buildUrl } from "@/utils/buildUrl";
import { websocketService } from '../services/websocketService';
import { MessageMiddleOut } from "@/features/messages/messageMiddleOut";
import { AvatarClient, CommandMessage, SpeakCommand, ExpressionCommand, IdleCommand } from "@/lib/avatarClient";
import { VRMExpressionPresetName } from "@pixiv/three-vrm";

const m_plus_2 = M_PLUS_2({
  variable: "--font-m-plus-2",
  display: "swap",
  preload: false,
});

const montserrat = Montserrat({
  variable: "--font-montserrat",
  display: "swap",
  subsets: ["latin"],
});

type LLMCallbackResult = {
  processed: boolean;
  error?: string;
};

export default function Home() {
  const { viewer } = useContext(ViewerContext);

  const [systemPrompt, setSystemPrompt] = useState(SYSTEM_PROMPT);
  const [openAiKey, setOpenAiKey] = useState("");
  const [elevenLabsKey, setElevenLabsKey] = useState("");
  const [elevenLabsParam, setElevenLabsParam] = useState<ElevenLabsParam>(DEFAULT_ELEVEN_LABS_PARAM);
  const [koeiroParam, setKoeiroParam] = useState<KoeiroParam>(DEFAULT_KOEIRO_PARAM);
  const [chatProcessing, setChatProcessing] = useState(false);
  const [chatLog, setChatLog] = useState<Message[]>([]);
  const [assistantMessage, setAssistantMessage] = useState("");
  const [backgroundImage, setBackgroundImage] = useState<string>('');
  const [restreamTokens, setRestreamTokens] = useState<any>(null);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  // needed because AI speaking could involve multiple audios being played in sequence
  const [isAISpeaking, setIsAISpeaking] = useState(false);
  const [openRouterKey, setOpenRouterKey] = useState<string>(() => {
    // Try to load from localStorage on initial render
    if (typeof window !== 'undefined') {
      return localStorage.getItem('openRouterKey') || '';
    }
    return '';
  });
  
  // WebSocket avatar control client
  const avatarClient = useRef<AvatarClient | null>(null);
  const [wsConnected, setWsConnected] = useState(false);

  useEffect(() => {
    if (window.localStorage.getItem("chatVRMParams")) {
      const params = JSON.parse(
        window.localStorage.getItem("chatVRMParams") as string
      );
      setSystemPrompt(params.systemPrompt);
      setElevenLabsParam(params.elevenLabsParam);
      setChatLog(params.chatLog);
    }
    if (window.localStorage.getItem("elevenLabsKey")) {
      const key = window.localStorage.getItem("elevenLabsKey") as string;
      setElevenLabsKey(key);
    }
    // load openrouter key from localStorage
    const savedOpenRouterKey = localStorage.getItem('openRouterKey');
    if (savedOpenRouterKey) {
      setOpenRouterKey(savedOpenRouterKey);
    }
    const savedBackground = localStorage.getItem('backgroundImage');
    if (savedBackground) {
      setBackgroundImage(savedBackground);
    }
  }, []);

  useEffect(() => {
    process.nextTick(() => {
      window.localStorage.setItem(
        "chatVRMParams",
        JSON.stringify({ systemPrompt, elevenLabsParam, chatLog })
      )

      // store separately to be backward compatible with local storage data
      window.localStorage.setItem("elevenLabsKey", elevenLabsKey);
    }
    );
  }, [systemPrompt, elevenLabsParam, chatLog]);

  useEffect(() => {
    if (backgroundImage) {
      document.body.style.backgroundImage = `url(${backgroundImage})`;
      // document.body.style.backgroundSize = 'cover';
      // document.body.style.backgroundPosition = 'center';
    } else {
      document.body.style.backgroundImage = `url(${buildUrl("/bg-c.png")})`;
    }
  }, [backgroundImage]);

  const handleChangeChatLog = useCallback(
    (targetIndex: number, text: string) => {
      const newChatLog = chatLog.map((v: Message, i) => {
        return i === targetIndex ? { role: v.role, content: text } : v;
      });

      setChatLog(newChatLog);
    },
    [chatLog]
  );

  /**
   * 文ごとに音声を直接でリクエストしながら再生する
   */
  const handleSpeakAi = useCallback(
    async (
      screenplay: Screenplay,
      elevenLabsKey: string,
      elevenLabsParam: ElevenLabsParam,
      onStart?: () => void,
      onEnd?: () => void
    ) => {
      setIsAISpeaking(true);  // Set speaking state before starting
      try {
        await speakCharacter(
          screenplay, 
          elevenLabsKey, 
          elevenLabsParam, 
          viewer, 
          () => {
            setIsPlayingAudio(true);
            console.log('audio playback started');
            onStart?.();
          }, 
          () => {
            setIsPlayingAudio(false);
            console.log('audio playback completed');
            onEnd?.();
          }
        );
      } catch (error) {
        console.error('Error during AI speech:', error);
      } finally {
        setIsAISpeaking(false);  // Ensure speaking state is reset even if there's an error
      }
    },
    [viewer]
  );

  /**
   * アシスタントとの会話を行う
   */
  const handleSendChat = useCallback(
    async (text: string) => {
      const newMessage = text;
      if (newMessage == null) return;

      setChatProcessing(true);
      // Add user's message to chat log
      const messageLog: Message[] = [
        ...chatLog,
        { role: "user", content: newMessage },
      ];
      setChatLog(messageLog);

      // Process messages through MessageMiddleOut
      const messageProcessor = new MessageMiddleOut();
      const processedMessages = messageProcessor.process([
        {
          role: "system",
          content: systemPrompt,
        },
        ...messageLog,
      ]);

      let localOpenRouterKey = openRouterKey;
      if (!localOpenRouterKey) {
        // fallback to free key for users to try things out
        localOpenRouterKey = process.env.NEXT_PUBLIC_OPENROUTER_API_KEY!;
      }

      const stream = await getChatResponseStream(processedMessages, openAiKey, localOpenRouterKey).catch(
        (e) => {
          console.error(e);
          return null;
        }
      );
      if (stream == null) {
        setChatProcessing(false);
        return;
      }

      const reader = stream.getReader();
      let receivedMessage = "";
      let aiTextLog = "";
      let tag = "";
      const sentences = new Array<string>();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          receivedMessage += value;

          // console.log('receivedMessage');
          // console.log(receivedMessage);

          // 返答内容のタグ部分の検出
          const tagMatch = receivedMessage.match(/^\[(.*?)\]/);
          if (tagMatch && tagMatch[0]) {
            tag = tagMatch[0];
            receivedMessage = receivedMessage.slice(tag.length);

            console.log('tag:');
            console.log(tag);
          }

          // 返答を一単位で切り出して処理する
          const sentenceMatch = receivedMessage.match(
            /^(.+[。．！？\n.!?]|.{10,}[、,])/
          );
          if (sentenceMatch && sentenceMatch[0]) {
            const sentence = sentenceMatch[0];
            sentences.push(sentence);

            console.log('sentence:');
            console.log(sentence);

            receivedMessage = receivedMessage
              .slice(sentence.length)
              .trimStart();

            // 発話不要/不可能な文字列だった場合はスキップ
            if (
              !sentence.replace(
                /^[\s\[\(\{「［（【『〈《〔｛«‹〘〚〛〙›»〕》〉』】）］」\}\)\]]+$/g,
                ""
              )
            ) {
              continue;
            }

            const aiText = `${tag} ${sentence}`;
            const aiTalks = textsToScreenplay([aiText], koeiroParam);
            aiTextLog += aiText;

            // 文ごとに音声を生成 & 再生、返答を表示
            const currentAssistantMessage = sentences.join(" ");
            handleSpeakAi(aiTalks[0], elevenLabsKey, elevenLabsParam, () => {
              setAssistantMessage(currentAssistantMessage);
            });
          }
        }
      } catch (e) {
        setChatProcessing(false);
        console.error(e);
      } finally {
        reader.releaseLock();
      }

      // アシスタントの返答をログに追加
      const messageLogAssistant: Message[] = [
        ...messageLog,
        { role: "assistant", content: aiTextLog },
      ];

      setChatLog(messageLogAssistant);
      setChatProcessing(false);
    },
    [systemPrompt, chatLog, handleSpeakAi, openAiKey, elevenLabsKey, elevenLabsParam, openRouterKey]
  );

  const handleTokensUpdate = useCallback((tokens: any) => {
    setRestreamTokens(tokens);
  }, []);

  // Set up global websocket handler
  useEffect(() => {
    websocketService.setLLMCallback(async (message: string): Promise<LLMCallbackResult> => {
      try {
        if (isAISpeaking || isPlayingAudio || chatProcessing) {
          console.log('Skipping message processing - system busy');
          return {
            processed: false,
            error: 'System is busy processing previous message'
          };
        }
        
        await handleSendChat(message);
        return {
          processed: true
        };
      } catch (error) {
        console.error('Error processing message:', error);
        return {
          processed: false,
          error: error instanceof Error ? error.message : 'Unknown error occurred'
        };
      }
    });
  }, [handleSendChat, chatProcessing, isPlayingAudio, isAISpeaking]);

  const handleOpenRouterKeyChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newKey = event.target.value;
    setOpenRouterKey(newKey);
    localStorage.setItem('openRouterKey', newKey);
  };

  // Initialize WebSocket avatar control client
  useEffect(() => {
    if (!avatarClient.current && viewer) {
      console.log('🤖 Initializing Avatar Control Client...');
      const client = new AvatarClient('ws://localhost:8765');
      
      // Set up command handlers
      client.onCommand(async (command: CommandMessage) => {
        console.log('📥 Received command:', command.type);
        
        try {
          switch (command.type) {
            case 'speak':
            case 'startSpeaking': {
              const cmd = command as any;
              const text = cmd.text || '';
              const emotion = cmd.emotion || 'neutral';
              const audioUrl = cmd.audioUrl || '';
              console.log('🎤 Speaking:', text, 'with emotion:', emotion);
              
              // Convert emotion to screenplay format
              const screenplayText = `[${emotion}] ${text}`;
              const screenplay = textsToScreenplay([screenplayText], koeiroParam)[0];
              
              // Play audio from URL if provided
              if (audioUrl) {
                try {
                  // Audio URL from server is relative, make it absolute
                  const fullUrl = audioUrl.startsWith('http') ? audioUrl : `http://localhost:8766${audioUrl}`;
                  console.log('🔊 Fetching audio from:', fullUrl);
                  const response = await fetch(fullUrl);
                  const audioBuffer = await response.arrayBuffer();
                  await viewer.model?.speak(audioBuffer, screenplay);
                } catch (error) {
                  console.error('Failed to load audio from URL:', error);
                  await viewer.model?.speak(null, screenplay);
                }
              } else {
                await viewer.model?.speak(null, screenplay);
              }
              break;
            }
            
            case 'setExpression':
            case 'updateExpression': {
              const cmd = command as any;
              const exprName = cmd.name || cmd.expression || 'neutral';
              console.log('😊 Setting expression:', exprName);
              
              // Map common emotion names to VRM preset names
              const emotionMap: { [key: string]: VRMExpressionPresetName } = {
                'neutral': 'neutral',
                'happy': 'happy',
                'angry': 'angry',
                'sad': 'sad',
                'relaxed': 'relaxed',
                'surprised': 'surprised',
              };
              
              const expression = emotionMap[exprName.toLowerCase()] || 'neutral';
              viewer.model?.expressionController?.playEmotion(expression);
              break;
            }
            
            case 'setIdle': {
              const cmd = command as IdleCommand;
              console.log('💤 Setting idle mode:', cmd.mode);
              // Idle animations are handled by the auto blink/look system
              // We could extend this to control breathing animations
              break;
            }
            
            case 'getStatus': {
              console.log('📊 Status requested');
              client.send({
                type: 'status',
                connected: true,
                speaking: isAISpeaking,
                expression: 'neutral', // Could track current expression
              });
              break;
            }
            
            case 'identifyAck':
            case 'initialState':
              // Server handshake messages - no action needed
              break;

            default:
              console.warn('Unknown command type:', command.type);
          }
        } catch (error) {
          console.error('Error handling command:', error);
        }
      });
      
      // Listen for connection state changes
      client.onConnectionChange((connected) => {
        console.log(`🔗 Connection state changed: ${connected}`);
        setWsConnected(connected);
      });
      
      // Connect to server
      client.connect();
      avatarClient.current = client;
      
      return () => {
        client.disconnect();
        avatarClient.current = null;
      };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer]);

  return (
    <div className={`${m_plus_2.variable} ${montserrat.variable}`}>
      <Meta />
      
      {/* WebSocket connection status indicator */}
      <div style={{
        position: 'fixed',
        top: '10px',
        right: '10px',
        padding: '8px 12px',
        borderRadius: '4px',
        backgroundColor: wsConnected ? '#10b981' : '#ef4444',
        color: 'white',
        fontSize: '12px',
        fontWeight: 'bold',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        gap: '6px'
      }}>
        <span style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          backgroundColor: 'white',
          animation: wsConnected ? 'pulse 2s infinite' : 'none'
        }} />
        {wsConnected ? '🟢 Control Server Connected' : '🔴 Control Server Disconnected'}
      </div>
      
      <Introduction
        openAiKey={openAiKey}
        onChangeAiKey={setOpenAiKey}
        elevenLabsKey={elevenLabsKey}
        onChangeElevenLabsKey={setElevenLabsKey}
      />
      <VrmViewer />
      <MessageInputContainer
        isChatProcessing={chatProcessing}
        onChatProcessStart={handleSendChat}
      />
      <Menu
        openAiKey={openAiKey}
        elevenLabsKey={elevenLabsKey}
        openRouterKey={openRouterKey}
        systemPrompt={systemPrompt}
        chatLog={chatLog}
        elevenLabsParam={elevenLabsParam}
        koeiroParam={koeiroParam}
        assistantMessage={assistantMessage}
        onChangeAiKey={setOpenAiKey}
        onChangeElevenLabsKey={setElevenLabsKey}
        onChangeSystemPrompt={setSystemPrompt}
        onChangeChatLog={handleChangeChatLog}
        onChangeElevenLabsParam={setElevenLabsParam}
        onChangeKoeiromapParam={setKoeiroParam}
        handleClickResetChatLog={() => setChatLog([])}
        handleClickResetSystemPrompt={() => setSystemPrompt(SYSTEM_PROMPT)}
        backgroundImage={backgroundImage}
        onChangeBackgroundImage={setBackgroundImage}
        onTokensUpdate={handleTokensUpdate}
        onChatMessage={handleSendChat}
        onChangeOpenRouterKey={handleOpenRouterKeyChange}
      />
      <GitHubLink />
    </div>
  );
}
