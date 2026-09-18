import type { UserQuestionRequest } from "./approval-gateway"

export function validateAnswers(request: UserQuestionRequest, answers: Readonly<Record<string, string | readonly string[]>>): void {
  const ids = new Set(request.questions.map(question => question.id))
  if (Object.keys(answers).some(id => !ids.has(id))) throw new Error("The answer contains an unknown question")
  for (const question of request.questions) {
    const answer = answers[question.id]
    const values = typeof answer === "string" ? [answer] : answer
    if (!values?.length || values.some(value => !value.trim())) throw new Error(`Answer required: ${question.header}`)
    if (question.options?.length && !question.allowOther && values.some(value => !question.options!.some(option => option.label === value))) throw new Error(`Choose a listed option: ${question.header}`)
  }
}
