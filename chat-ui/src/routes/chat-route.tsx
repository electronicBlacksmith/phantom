import { useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { EmptyState } from "@/components/empty-state";
import { ChatInput } from "@/components/chat-input";
import { createSession } from "@/lib/client";

export function ChatRoute() {
  const navigate = useNavigate();
  const creatingRef = useRef(false);

  const handleCreateAndNavigate = useCallback(
    async (text: string) => {
      if (creatingRef.current) return;
      creatingRef.current = true;
      try {
        const result = await createSession();
        navigate(`/s/${result.id}`, { state: { initialMessage: text } });
      } finally {
        creatingRef.current = false;
      }
    },
    [navigate],
  );

  return (
    <>
      <EmptyState onSuggestionClick={handleCreateAndNavigate} />
      <ChatInput
        onSend={handleCreateAndNavigate}
        onStop={() => {}}
        isStreaming={false}
      />
    </>
  );
}
